#!/usr/bin/env node

/**
 * 크몽 자동화 스케줄러
 *
 * - 새 의뢰 스크래핑(공개 JSON API) → Phase 1~3 자동 실행 (카테고리 필터 없음, 전 분야 지원)
 * - 완료 시 슬랙 #위시켓-알림 채널(위시켓 봇과 공용 웹훅)에 "[크몽]" 접두사로 결과 전송
 * - 크몽은 댓글 기능이 없으므로 위시켓 봇의 "비밀 댓글" 단계는 없음
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { WORKSPACE } = require('../lib/workspace');
const { sendSlack } = require('../lib/slack');
const SEEN_FILE = path.join(WORKSPACE, 'data/kmong-seen.json');

function loadSeen() {
  if (!fs.existsSync(SEEN_FILE)) return { projects: [] };
  return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf-8'));
}

function saveSeen(data) {
  const dir = path.dirname(SEEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify(data, null, 2));
}

function runPhase1(projectId) {
  console.log(`[Phase 1] ${projectId} 시작...`);
  const result = spawnSync('node', [
    path.join(WORKSPACE, 'scripts/kmong-auto-phase1.js'),
    projectId
  ], {
    cwd: WORKSPACE,
    encoding: 'utf-8',
    timeout: 300000,
    maxBuffer: 20 * 1024 * 1024
  });

  try {
    const logsDir = path.join(WORKSPACE, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const logPath = path.join(logsDir, `phase1-${projectId}-${ts}.log`);
    fs.writeFileSync(logPath,
      `=== phase1 exit code: ${result.status} ===\n` +
      `=== stdout ===\n${result.stdout || ''}\n` +
      `=== stderr ===\n${result.stderr || ''}\n`);
    console.log(`  phase1 log: ${logPath}`);
  } catch (e) { console.error(`  phase1 log 저장 실패: ${e.message}`); }

  if (result.status !== 0) {
    throw new Error(`Phase 1 실패 (exit ${result.status}): ${(result.stderr || result.stdout || '').slice(-300)}`);
  }

  const output = result.stdout;

  if (output.includes('비공개(컴피덴셔션) 프로젝트 - 건너뜀')) {
    console.log(`[Phase 1] ${projectId} 비공개 프로젝트 - 스킵`);
    return null;
  }

  const jsonMatch = output.match(/PHASE1_RESULT:(\{.+\})/);
  if (jsonMatch) {
    const phase1Data = JSON.parse(jsonMatch[1]);
    return {
      proposalContentFile: phase1Data.proposalContentFile,
      prototypePromptFile: phase1Data.prototypePromptFile,
      portfolioFile: phase1Data.portfolioFile,
      llmResponseFile: phase1Data.llmResponseFile,
      title: phase1Data.projectTitle || projectId
    };
  }

  return null;
}

function runPhase2(prototypePromptFile, proposalContentFile) {
  const mode = process.env.DESIGN_MODE || 'auto';

  // R2 자격증명이 없으면 시제품을 생성해도 업로드(공유 URL 발급)가 불가능하다.
  // 10분+ 걸리는 생성 자체를 건너뛰고 시제품 없이 제안하는 쪽으로 우아하게 강등한다.
  if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.log('[Phase 2] ⚠️  R2 자격증명 미설정 — 시제품 생성 생략, 시제품 없이 제안 진행');
    return null;
  }

  console.log(`[Phase 2] 시제품 생성 시작 (mode: ${mode})...`);

  let result;
  if (mode !== 'cli') {
    result = spawnSync('node', [
      path.join(WORKSPACE, 'scripts/automate-claude-design.js'),
      prototypePromptFile
    ], {
      cwd: WORKSPACE,
      encoding: 'utf-8',
      timeout: 50 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024
    });

    const browserFailed = result.status !== 0 || !/"success"\s*:\s*true/.test(result.stdout || '');
    if (browserFailed && mode === 'auto') {
      console.log('  ⚠️  브라우저 자동화 실패 — claude CLI 모드로 폴백');
      result = null;
    }
  }

  if (!result) {
    result = spawnSync('node', [
      path.join(WORKSPACE, 'scripts/generate-design-cli.js'),
      prototypePromptFile
    ], {
      cwd: WORKSPACE,
      encoding: 'utf-8',
      timeout: 25 * 60 * 1000,
      maxBuffer: 30 * 1024 * 1024
    });
  }

  const output = result.stdout || '';

  if (output.includes('CREDIT_EXHAUSTED') || output.includes('AI 크레딧 소진')) {
    console.log(`  ⚠️  AI 크레딧 소진 - 이 프로젝트 스킵 (seen 미추가)`);
    const err = new Error('CREDIT_EXHAUSTED');
    err.creditExhausted = true;
    throw err;
  }

  let prototypeUrl = null;
  const jsonMatch = output.match(/"success"\s*:\s*true\s*,\s*"url"\s*:\s*"([^"]+)"/);
  if (jsonMatch) {
    prototypeUrl = jsonMatch[1];
    console.log(`  ✅ Prototype URL (JSON): ${prototypeUrl}`);
  }

  if (!prototypeUrl) {
    const labelMatch = output.match(/(?:Design|Prototype)\s*URL:\s*(https:\/\/\S+)/i);
    if (labelMatch) {
      prototypeUrl = labelMatch[1].replace(/[)\].,]+$/, '');
      console.log(`  ✅ Prototype URL (라벨): ${prototypeUrl}`);
    }
  }

  if (!prototypeUrl) {
    // 시제품은 제안의 부가 요소 — 업로드/추출 실패로 지원 자체를 막지 않고
    // 시제품 없이 제안하는 쪽으로 강등한다.
    console.error(`  ⚠️  Prototype URL을 찾을 수 없습니다 — 시제품 없이 제안 진행`);
    console.error(`  stdout (last 500): ${output.slice(-500)}`);
    return null;
  }

  if (proposalContentFile && fs.existsSync(proposalContentFile)) {
    let content = fs.readFileSync(proposalContentFile, 'utf-8');
    content = content.replace(/\{\{PROTOTYPE_URL\}\}/g, prototypeUrl);
    fs.writeFileSync(proposalContentFile, content, 'utf-8');
    console.log(`  ✅ proposal-content.txt 업데이트 완료`);
  }

  return prototypeUrl;
}

function runPhase3(projectId, phase1Data) {
  console.log(`[Phase 3] 제안 제출 시작...`);

  const args = [
    path.join(WORKSPACE, 'scripts/automate-kmong-apply.js'),
    `https://kmong.com/custom-project/requests/${projectId}`,
    phase1Data.proposalContentFile || '',
    phase1Data.prototypeUrl || '',
  ];
  if (phase1Data.portfolioFile) args.push(phase1Data.portfolioFile);

  const result = spawnSync('node', args, {
    cwd: WORKSPACE,
    encoding: 'utf-8',
    timeout: 300000,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env }
  });

  try {
    const logsDir = path.join(WORKSPACE, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const logPath = path.join(logsDir, `phase3-${projectId}-${ts}.log`);
    fs.writeFileSync(logPath,
      `=== phase3 exit code: ${result.status} ===\n` +
      `=== stdout ===\n${result.stdout || ''}\n` +
      `=== stderr ===\n${result.stderr || ''}\n`);
    console.log(`  phase3 log: ${logPath}`);
  } catch (e) { console.error(`  phase3 log 저장 실패: ${e.message}`); }

  const output = result.stdout || '';
  const isDryRun = /"dryRun"\s*:\s*true/.test(output);

  return { success: result.status === 0 && !isDryRun, dryRun: isDryRun };
}

async function processProject(project, seenData) {
  const projectId = String(project.id);

  console.log(`\n🚀 ${projectId}: ${project.title}`);

  try {
    const phase1 = runPhase1(projectId);
    if (phase1 === null) {
      seenData.projects.push(projectId);
      saveSeen(seenData);
      return;
    }
    if (!phase1.proposalContentFile) {
      // LLM이 응답은 했지만 제안서 섹션을 만들지 않은 경우 = 역량 불일치 등으로
      // 작성을 의도적으로 거부한 것. 재시도해도 결과가 같으므로 seen에 넣어
      // 매시간 재시도→실패 알림 반복(스팸)을 끊고, 사유를 정보성 알림으로 보낸다.
      if (phase1.llmResponseFile && fs.existsSync(phase1.llmResponseFile)) {
        const reason = fs.readFileSync(phase1.llmResponseFile, 'utf-8').trim();
        seenData.projects.push(projectId);
        saveSeen(seenData);
        console.log(`⏭️  ${projectId} 지원 안 함 (역량 불일치 판단) — seen 처리, 재시도 안 함`);
        await sendSlack([
          `⏭️ [크몽] 지원 안 함 (역량 불일치) | 프로젝트 ${projectId}`,
          `📌 ${phase1.title}`,
          `🔗 https://kmong.com/custom-project/requests/${projectId}`,
          ``,
          `사유 요약: ${reason.slice(0, 300)}${reason.length > 300 ? '…' : ''}`,
          `(회사 포트폴리오와 무관한 분야로 판단되어 허위 제안 없이 스킵 — 재시도하지 않음)`
        ].join('\n'));
        return;
      }
      throw new Error('Phase 1 결과 없음 (proposalContentFile 없음)');
    }

    const prototypeUrl = runPhase2(phase1.prototypePromptFile, phase1.proposalContentFile);
    phase1.prototypeUrl = prototypeUrl;

    // 시제품 없이 진행하는 경우: 제안서에 남은 "시제품 미리보기: {{PROTOTYPE_URL}}" 줄을
    // 제거해 미치환 변수 검사(수동 제안 경로)에 걸리지 않게 한다.
    if (!prototypeUrl && phase1.proposalContentFile && fs.existsSync(phase1.proposalContentFile)) {
      let content = fs.readFileSync(phase1.proposalContentFile, 'utf-8');
      content = content
        .split('\n')
        .filter(line => !line.includes('{{PROTOTYPE_URL}}'))
        .join('\n')
        .replace(/^\s*\n+/, '');
      fs.writeFileSync(phase1.proposalContentFile, content, 'utf-8');
      console.log('  ℹ️  시제품 없이 제안 — 제안서에서 시제품 링크 줄 제거');
    }

    if (phase1.proposalContentFile && fs.existsSync(phase1.proposalContentFile)) {
      const content = fs.readFileSync(phase1.proposalContentFile, 'utf-8');
      const unresolved = content.match(/\{\{[^}]+\}\}/g);
      if (unresolved) {
        console.log(`⚠️  [Phase 3 중단] 미치환 변수 발견: ${unresolved.join(', ')}`);
        const projectUrl = `https://kmong.com/custom-project/requests/${projectId}`;
        const manualMsg = [
          `⚠️ [크몽] 수동 제안 필요 | 프로젝트 ${projectId}`,
          `📌 ${phase1.title}`,
          `🔗 ${projectUrl}`,
          ``,
          `미치환 변수: ${unresolved.join(', ')}`,
          `시제품 URL: ${prototypeUrl || '생성 실패'}`,
          ``,
          `제안 내용 파일: ${phase1.proposalContentFile}`,
          `시제품 URL을 직접 넣어 수동 제안해주세요.`
        ].join('\n');
        await sendSlack(manualMsg);
        return;
      }
    }

    const { success, dryRun } = runPhase3(projectId, phase1);

    // 제출 실패는 seen에 넣지 않는다 — 다음 회차에 재시도 (성공/드라이런만 완료 처리)
    if (!success && !dryRun) {
      throw new Error('Phase 3 제출 실패 (phase3 로그 확인)');
    }

    seenData.projects.push(projectId);
    saveSeen(seenData);

    const projectUrl = `https://kmong.com/custom-project/requests/${projectId}`;
    let status;
    if (dryRun) status = '🧪 [크몽] DRY-RUN 완료 (실제 제출 안 함)';
    else if (success) status = '✅ [크몽] 제안 완료';
    else status = '⚠️ [크몽] 제안 중 오류';

    const msg = [
      `${status} | 프로젝트 ${projectId}`,
      `📌 ${phase1.title}`,
      `🔗 ${projectUrl}`,
      prototypeUrl ? `🎨 시제품: ${prototypeUrl}` : '',
      dryRun ? `제안 내용 파일: ${phase1.proposalContentFile}\nSKIP_SUBMIT=false 로 재실행하면 실제 제출됩니다.` : '',
    ].filter(Boolean).join('\n');

    await sendSlack(msg);
    console.log(`\n${status}: ${projectId}\n`);

  } catch (err) {
    if (err.creditExhausted) {
      console.log(`⏸️  ${projectId} 크레딧 소진으로 스킵 (seen 미추가 - 나중에 재시도 가능)`);
      await sendSlack(`⏸️ [크몽] 크레딧 소진으로 패스 | 프로젝트 ${projectId}\n📌 ${project.title}\n크레딧 리셋 후 자동 재시도됩니다.`);
      return;
    }

    console.error(`❌ ${projectId} 실패: ${err.message}`);
    console.log(`   ↻ seen 미추가 — 다음 회차 자동 재시도`);

    await sendSlack(`❌ [크몽] 제안 실패 | 프로젝트 ${projectId}\n📌 ${project.title}\n오류: ${err.message.slice(0, 100)}\n(seen 미추가 — 다음 회차 재시도)`);
  }
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🕐 크몽 스케줄러 실행: ${new Date().toLocaleString('ko-KR')}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  try {
    const scrapeResult = require('child_process').execSync(`node ${path.join(WORKSPACE, 'scripts/kmong-scraper.js')}`, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024
    });
    const projects = JSON.parse(scrapeResult);
    console.log(`📋 총 ${projects.length}개 프로젝트 수집\n`);

    const seenData = loadSeen();
    const seenIds = new Set((seenData.projects || []).map(String));

    const newProjects = projects.filter(p => p.status === 'APPROVAL' && !seenIds.has(String(p.id)));

    console.log(`🆕 신규: ${newProjects.length}개\n`);

    if (newProjects.length === 0) {
      console.log('ℹ️  신규 프로젝트 없음\n');
      return;
    }

    for (const project of newProjects) {
      await processProject(project, seenData);
      await new Promise(r => setTimeout(r, 30000));
    }

  } catch (err) {
    console.error(`❌ 스케줄러 오류: ${err.message}`);
    await sendSlack(`❌ [크몽] 스케줄러 오류: ${err.message.slice(0, 200)}`);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ 완료: ${new Date().toLocaleString('ko-KR')}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main();
