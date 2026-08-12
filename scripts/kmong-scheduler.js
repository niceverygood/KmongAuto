#!/usr/bin/env node

/**
 * 크몽 자동화 스케줄러 (최상위 오케스트레이터)
 *
 * - 신규 프로젝트 스크래핑(공개 API) → 필터링 → Phase 1~3 자동 실행
 * - 상주(RESIDENT) / UI·UX 전용 / 개발 무관 프로젝트 제외
 * - 완료 시 슬랙 채널에 결과 전송
 *
 * seen 규칙 (위시켓과 동일):
 * - 성공 / 필터 스킵 → seen 추가 (재지원 방지)
 * - 실패 → seen 미추가 (다음 회차 자동 재시도)
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const { WORKSPACE } = require('../lib/workspace');
const { sendSlack } = require('../lib/slack');

const SEEN_FILE = path.join(WORKSPACE, 'data/kmong-seen.json');
const CONFIG_FILE = path.join(WORKSPACE, 'config/kmong.config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch { return {}; }
}
const CONFIG = loadConfig();

// UI/UX 전용 또는 기획 전용 프로젝트 필터 키워드 (위시켓과 동일 기준)
const SKIP_KEYWORDS = [
  'UI/UX', 'UI/ UX', 'UX/UI', 'UX 디자인', 'UI 디자인',
  '디자인 기획', '기획만', '기획 전문', 'UX 기획',
  '서비스 기획', '기획서 작성', '앱 기획', '웹 기획',
  '화면설계', '스토리보드', '와이어프레임', '프로토타입 기획',
  'IA 설계', '정보구조', '그래픽 디자인', '브랜딩 디자인',
  '로고 디자인', '배너 디자인', '영상 편집', '영상 제작',
  '모션 그래픽', '일러스트', '캐릭터 디자인',
  // "UI 디자인"은 "UI 디자이너"를 못 잡는다(디자인 vs 디자이너) — 디자이너 채용 공고를
  // 따로 명시. '디자이너' 단독은 "개발자 및 디자이너 모집" 같은 개발 건까지 걸러내므로 쓰지 않음.
  'UI 디자이너', 'UX 디자이너', '디자이너 모집', '디자이너 채용',
];

// 개발 관련 키워드 (제목 또는 본문 앞부분에 하나라도 있으면 지원)
const INCLUDE_KEYWORDS = [
  '개발', '구축', '제작', 'API', '앱 개발', '웹 개발',
  '백엔드', '프론트엔드', 'Flutter', 'React', 'Next.js',
  'Spring', 'Node', 'Python', 'Java', 'Swift', 'Kotlin',
  '자동화', '크롤링', 'AI', '머신러닝', '데이터',
  '플랫폼', '시스템', '솔루션', '서버', '홈페이지', '쇼핑몰',
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

// 필터: 상주 / UI·UX 전용 / 개발 무관이면 skip
// options.projectTypes 로 허용 진행방식을 호출부에서 덮어쓸 수 있다
// (backfill 의 --include-resident 용). 없으면 config → 기본값 순으로 폴백.
function shouldSkip(project, options = {}) {
  const allowedTypes = options.projectTypes || CONFIG.projectTypes || ['OUTSOURCING'];
  if (project.projectType && !allowedTypes.includes(project.projectType)) {
    return { skip: true, reason: `진행 방식 제외: ${project.projectType} (상주 등)` };
  }

  const t = project.title || '';
  for (const kw of SKIP_KEYWORDS) {
    if (t.includes(kw)) {
      return { skip: true, reason: `스킵 키워드: "${kw}"` };
    }
  }

  // 제목 + 본문 앞 400자에서 개발 키워드 확인
  const haystack = t + ' ' + (project.content || '').slice(0, 400);
  const hasDevKeyword = INCLUDE_KEYWORDS.some(kw => haystack.includes(kw));
  if (!hasDevKeyword) {
    return { skip: true, reason: '개발 관련 키워드 없음' };
  }

  const maxProposals = Number(CONFIG.maxProposalCount) || 999;
  if ((project.proposalCount || 0) > maxProposals) {
    return { skip: true, reason: `제안 ${project.proposalCount}건 > 상한 ${maxProposals}` };
  }

  return { skip: false };
}

function saveRunLog(prefix, id, result) {
  try {
    const logsDir = path.join(WORKSPACE, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const logPath = path.join(logsDir, `${prefix}-${id}-${ts}.log`);
    fs.writeFileSync(logPath,
      `=== ${prefix} exit code: ${result.status} ===\n` +
      `=== stdout ===\n${result.stdout || ''}\n` +
      `=== stderr ===\n${result.stderr || ''}\n`);
    console.log(`  ${prefix} log: ${logPath}`);
  } catch (e) { console.error(`  ${prefix} log 저장 실패: ${e.message}`); }
}

function runPhase1(project) {
  console.log(`[Phase 1] ${project.id} 시작...`);

  // 스크래핑 결과를 그대로 넘겨 phase1의 재조회 생략
  const tempDir = path.join(WORKSPACE, 'temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const projectJsonFile = path.join(tempDir, `kmong-${project.id}-project.json`);
  fs.writeFileSync(projectJsonFile, JSON.stringify(project, null, 2));

  const result = spawnSync('node', [
    path.join(WORKSPACE, 'scripts/kmong-auto-phase1.js'),
    String(project.id),
    projectJsonFile,
  ], {
    cwd: WORKSPACE,
    encoding: 'utf-8',
    timeout: 15 * 60 * 1000, // 15분 (LLM 10분 + 여유)
    maxBuffer: 20 * 1024 * 1024,
  });

  saveRunLog('phase1', project.id, result);

  if (result.status !== 0) {
    throw new Error(`Phase 1 실패 (exit ${result.status}): ${(result.stderr || result.stdout || '').slice(-300)}`);
  }

  const jsonMatch = (result.stdout || '').match(/PHASE1_RESULT:(\{.+\})/);
  if (!jsonMatch) throw new Error('Phase 1 결과(PHASE1_RESULT) 파싱 실패');
  return JSON.parse(jsonMatch[1]);
}

function runPhase2(designPromptFile, proposalContentFile) {
  console.log(`[Phase 2] Design (claude.ai/design) 시작...`);
  const result = spawnSync('node', [
    path.join(WORKSPACE, 'scripts/automate-claude-design.js'),
    designPromptFile,
  ], {
    cwd: WORKSPACE,
    encoding: 'utf-8',
    timeout: 50 * 60 * 1000, // 50분 (생성 30분 + 다운로드/업로드 여유)
    maxBuffer: 10 * 1024 * 1024,
  });

  const output = result.stdout || '';

  // 크레딧 소진 감지
  if (output.includes('CREDIT_EXHAUSTED') || output.includes('AI 크레딧 소진')) {
    console.log(`  ⚠️  AI 크레딧 소진 - 이 프로젝트 스킵 (seen 미추가)`);
    const err = new Error('CREDIT_EXHAUSTED');
    err.creditExhausted = true;
    throw err;
  }

  // 결과에서 Design URL 추출
  let designUrl = null;

  const jsonMatch = output.match(/"success"\s*:\s*true\s*,\s*"url"\s*:\s*"([^"]+)"/);
  if (jsonMatch) {
    designUrl = jsonMatch[1];
    console.log(`  ✅ Design URL (JSON): ${designUrl}`);
  }

  if (!designUrl) {
    const labelMatch = output.match(/(?:Design|Figma)\s*URL:\s*(https:\/\/\S+)/i);
    if (labelMatch) {
      designUrl = labelMatch[1].replace(/[)\].,]+$/, '');
      console.log(`  ✅ Design URL (라벨): ${designUrl}`);
    }
  }

  if (!designUrl) {
    console.error(`  ❌ Design URL을 찾을 수 없습니다`);
    console.error(`  stdout (last 500): ${output.slice(-500)}`);
    throw new Error('Design URL 추출 실패');
  }

  // 제안 내용의 {{FIGMA_URL}} 치환
  if (proposalContentFile && fs.existsSync(proposalContentFile)) {
    let content = fs.readFileSync(proposalContentFile, 'utf-8');
    content = content.replace(/\{\{FIGMA_URL\}\}/g, designUrl);
    fs.writeFileSync(proposalContentFile, content, 'utf-8');
    console.log(`  ✅ proposal-content 업데이트 완료`);
  }

  return designUrl;
}

function runPhase3(requestId, phase1Data, designUrl) {
  console.log(`[Phase 3] 제안 제출 시작...`);

  const result = spawnSync('node', [
    path.join(WORKSPACE, 'scripts/automate-kmong-apply.js'),
    String(requestId),
    phase1Data.proposalContentFile || '',
    phase1Data.termsFile || '',
    designUrl || '',
  ], {
    cwd: WORKSPACE,
    encoding: 'utf-8',
    timeout: 300000, // 5분
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env },
  });

  saveRunLog('phase3', requestId, result);

  return {
    success: result.status === 0,
    output: result.stdout || '',
  };
}

async function processProject(project, seenData, options = {}) {
  // 시제품(Phase 2) 생성 여부. options 우선, 없으면 config 값.
  const skipPrototype = options.skipPrototype ?? (CONFIG.skipPrototype === true);
  const portfolioUrl = options.portfolioUrl ?? (CONFIG.portfolioUrl || '');

  const requestId = String(project.id);
  if (!requestId) return;

  const { skip, reason } = shouldSkip(project, options);

  if (skip) {
    console.log(`⏭️  ${requestId} 스킵: ${reason} (${project.title})`);
    seenData.projects.push(requestId);
    saveSeen(seenData);
    return;
  }

  console.log(`\n🚀 ${requestId}: ${project.title}`);

  try {
    // Phase 1
    const phase1 = runPhase1(project);
    if (!phase1.proposalContentFile) throw new Error('Phase 1 결과 없음 (proposalContentFile 없음)');

    // Phase 2 — 시제품 생성. skipPrototype 이면 건너뛰고 제안서의 {{FIGMA_URL}} 를
    // 포트폴리오 URL 로 치환(없으면 시제품 라인 제거). claude.ai UI 자동화 의존성이
    // 사라져 제출 성공률이 크게 올라간다 (대신 맞춤 시제품 첨부는 생략됨).
    let designUrl;
    if (skipPrototype) {
      console.log('[Phase 2] 시제품 생성 건너뜀 (no-prototype 모드)');
      let content = fs.readFileSync(phase1.proposalContentFile, 'utf-8');
      if (portfolioUrl) {
        content = content.replace(/\{\{FIGMA_URL\}\}/g, portfolioUrl);
        designUrl = portfolioUrl;
      } else {
        content = content
          .split('\n')
          .filter(l => !l.includes('{{FIGMA_URL}}'))
          .join('\n')
          .replace(/\n{3,}/g, '\n\n');
        designUrl = '';
      }
      fs.writeFileSync(phase1.proposalContentFile, content);
    } else {
      designUrl = runPhase2(phase1.designPromptFile, phase1.proposalContentFile);
    }

    // Phase 3 진입 전: 미치환 변수 검사
    if (phase1.proposalContentFile && fs.existsSync(phase1.proposalContentFile)) {
      const content = fs.readFileSync(phase1.proposalContentFile, 'utf-8');
      const unresolved = content.match(/\{\{[^}]+\}\}/g);
      if (unresolved) {
        console.log(`⚠️  [Phase 3 중단] 미치환 변수 발견: ${unresolved.join(', ')}`);
        // seen에 추가하지 않음 → 나중에 수동 지원 가능
        const manualMsg = [
          `⚠️ 크몽 수동 제안 필요 | 프로젝트 ${requestId}`,
          `📌 ${phase1.projectTitle || project.title}`,
          `🔗 https://kmong.com/enterprise/requests/${requestId}`,
          ``,
          `미치환 변수: ${unresolved.join(', ')}`,
          `시제품 URL: ${designUrl || '생성 실패'}`,
          `제안 내용 파일: ${phase1.proposalContentFile}`,
          `시제품 URL을 직접 넣어 수동 제안해주세요.`,
        ].join('\n');
        await sendSlack(manualMsg);
        return;
      }
    }

    // Phase 3
    const { success, output } = runPhase3(requestId, phase1, designUrl);

    // seen 업데이트
    seenData.projects.push(requestId);
    saveSeen(seenData);

    // 제안 조건 로드 (슬랙 표시용)
    let termsText = '';
    try {
      const terms = JSON.parse(fs.readFileSync(phase1.termsFile, 'utf-8'));
      termsText = `💰 제안: ${Number(terms.amountManwon).toLocaleString('ko-KR')}만원 / ${terms.days}일`;
    } catch {}

    const status = success ? '✅ 크몽 제안 완료' : '⚠️ 크몽 제안 중 오류';
    const msg = [
      `${status} | 프로젝트 ${requestId}`,
      `📌 ${phase1.projectTitle || project.title}`,
      `🔗 https://kmong.com/enterprise/requests/${requestId}`,
      designUrl ? `🎨 시제품: ${designUrl}` : '',
      termsText,
    ].filter(Boolean).join('\n');

    await sendSlack(msg);
    console.log(`\n${status}: ${requestId}\n`);

  } catch (err) {
    // 크레딧 소진 - seen 미추가 (크레딧 리셋 후 재시도)
    if (err.creditExhausted) {
      console.log(`⏸️  ${requestId} 크레딧 소진으로 스킵 (seen 미추가 - 나중에 재시도)`);
      await sendSlack(`⏸️ 크몽 - AI 크레딧 소진으로 패스 | 프로젝트 ${requestId}\n📌 ${project.title}\n크레딧 리셋 후 자동 재시도됩니다.`);
      return;
    }

    console.error(`❌ ${requestId} 실패: ${err.message}`);

    // 실패는 seen 미추가 (다음 회차 재시도). 크몽에서 공고가 내려가면 자연 제외됨.
    console.log(`   ↻ seen 미추가 — 다음 회차 자동 재시도`);

    await sendSlack(`❌ 크몽 제안 실패 | 프로젝트 ${requestId}\n📌 ${project.title}\n오류: ${err.message.slice(0, 150)}\n(seen 미추가 — 다음 회차 재시도)`);
  }
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🕐 크몽 스케줄러 실행: ${new Date().toLocaleString('ko-KR')}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  try {
    // 스크래핑 (공개 API — 브라우저 불필요)
    const scrapeResult = execSync(`node ${path.join(WORKSPACE, 'scripts/kmong-scraper.js')}`, {
      encoding: 'utf-8',
      maxBuffer: 20 * 1024 * 1024,
    });
    const projects = JSON.parse(scrapeResult);
    console.log(`📋 총 ${projects.length}개 프로젝트 수집\n`);

    // 신규 필터
    const seenData = loadSeen();
    const seenIds = new Set((seenData.projects || []).map(String));

    const newProjects = projects.filter(p => p.id && !seenIds.has(String(p.id)));

    console.log(`🆕 신규: ${newProjects.length}개\n`);

    if (newProjects.length === 0) {
      console.log('ℹ️  신규 프로젝트 없음\n');
      return;
    }

    // 순서대로 처리 (한 번에 하나씩)
    const delaySec = Number(CONFIG.delayBetweenProjectsSec) || 30;
    for (const project of newProjects) {
      await processProject(project, seenData);
      await new Promise(r => setTimeout(r, delaySec * 1000));
    }

  } catch (err) {
    console.error(`❌ 스케줄러 오류: ${err.message}`);
    await sendSlack(`❌ 크몽 스케줄러 오류: ${err.message.slice(0, 200)}`);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ 완료: ${new Date().toLocaleString('ko-KR')}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

// 직접 실행하면 스케줄러 1회차를 돌리고, require 로 불러오면 함수만 노출한다
// (kmong-backfill.js 가 필터/제출 로직을 재사용하기 위함 — 로직 중복 방지).
module.exports = {
  main,
  processProject,
  shouldSkip,
  loadSeen,
  saveSeen,
  SKIP_KEYWORDS,
  INCLUDE_KEYWORDS,
};

if (require.main === module) {
  main();
}
