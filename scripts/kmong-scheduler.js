#!/usr/bin/env node

/**
 * 크몽 자동화 스케줄러
 *
 * - 새 의뢰 스크래핑(공개 JSON API) → 필터링 → Phase 1~3 자동 실행
 * - UI/UX 전용, 기획 전용, 상주(RESIDENT) 형태 프로젝트 제외
 * - 완료 시 슬랙 #위시켓-알림 채널(위시켓 봇과 공용 웹훅)에 "[크몽]" 접두사로 결과 전송
 * - 크몽은 댓글 기능이 없으므로 위시켓 봇의 "비밀 댓글" 단계는 없음
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { WORKSPACE } = require('../lib/workspace');
const { sendSlack } = require('../lib/slack');
const SEEN_FILE = path.join(WORKSPACE, 'data/kmong-seen.json');

const SKIP_KEYWORDS = [
  'UI/UX', 'UI/ UX', 'UX/UI', 'UX 디자인', 'UI 디자인',
  '디자인 기획', '기획만', '기획 전문', 'UX 기획',
  '서비스 기획', '기획서 작성', '앱 기획', '웹 기획',
  '화면설계', '스토리보드', '와이어프레임', '프로토타입 기획',
  'IA 설계', '정보구조', '그래픽 디자인', '브랜딩 디자인',
  '로고 디자인', '배너 디자인', '영상 편집', '영상 제작',
  '모션 그래픽', '일러스트', '캐릭터 디자인',
  'PMO', '사업관리', // 상주형 관리 인력 의뢰 제외
];

const INCLUDE_KEYWORDS = [
  '개발', '구축', '제작', 'API', '앱 개발', '웹 개발',
  '백엔드', '프론트엔드', 'Flutter', 'React', 'Next.js',
  'Spring', 'Node', 'Python', 'Java', 'Swift', 'Kotlin',
  '자동화', '크롤링', 'AI', '머신러닝', '데이터',
  '플랫폼', '시스템', '솔루션', '서버',
];

function loadSeen() {
  if (!fs.existsSync(SEEN_FILE)) return { projects: [] };
  return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf-8'));
}

function saveSeen(data) {
  const dir = path.dirname(SEEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify(data, null, 2));
}

function shouldSkip(title) {
  const t = title || '';
  for (const kw of SKIP_KEYWORDS) {
    if (t.includes(kw)) return { skip: true, reason: `스킵 키워드: "${kw}"` };
  }
  const hasDevKeyword = INCLUDE_KEYWORDS.some(kw => t.includes(kw));
  if (!hasDevKeyword) return { skip: true, reason: '개발 관련 키워드 없음' };
  return { skip: false };
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
      title: phase1Data.projectTitle || projectId
    };
  }

  return null;
}

function runPhase2(prototypePromptFile, proposalContentFile) {
  const mode = process.env.DESIGN_MODE || 'auto';
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
    console.error(`  ❌ Prototype URL을 찾을 수 없습니다`);
    console.error(`  stdout (last 500): ${output.slice(-500)}`);
    throw new Error('Prototype URL 추출 실패');
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

  const { skip, reason } = shouldSkip(project.title);

  if (skip) {
    console.log(`⏭️  ${projectId} 스킵: ${reason} (${project.title})`);
    seenData.projects.push(projectId);
    saveSeen(seenData);
    return;
  }

  console.log(`\n🚀 ${projectId}: ${project.title}`);

  try {
    const phase1 = runPhase1(projectId);
    if (phase1 === null) {
      seenData.projects.push(projectId);
      saveSeen(seenData);
      return;
    }
    if (!phase1.proposalContentFile) throw new Error('Phase 1 결과 없음 (proposalContentFile 없음)');

    const prototypeUrl = runPhase2(phase1.prototypePromptFile, phase1.proposalContentFile);
    phase1.prototypeUrl = prototypeUrl;

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
