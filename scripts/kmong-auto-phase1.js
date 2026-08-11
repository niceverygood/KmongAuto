#!/usr/bin/env node

/**
 * 크몽 자동화 Phase 1 — 제안 문안 생성
 *
 * 1. 프로젝트 정보 로드 (스케줄러가 넘긴 JSON 파일 또는 공개 API에서 ID 검색)
 * 2. claude CLI(구독)로 제안 자료 생성
 * 3. 응답을 3개 섹션으로 파싱 (디자인 프롬프트 / 제안 내용 / 제안 조건 JSON)
 * 4. 결과물 텍스트 파일 저장 + PHASE1_RESULT JSON stdout 출력
 *
 * Usage:
 *   node scripts/kmong-auto-phase1.js <requestId> [projectJsonFile]
 *
 * 위시켓과 달리 상세 수집용 브라우저가 필요 없음 — 목록 API가 전체 본문을 반환.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { findRequestById } = require('../lib/kmong-api');

// claude CLI 경로 자동 탐색 (구독 사용, API 키 불필요)
function findClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const home = process.env.HOME || `/Users/${process.env.USER || 'domo'}`;
  const candidates = [
    `${home}/.npm-global/bin/claude`,
    `${home}/.local/bin/claude`,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    return execSync('which claude', { encoding: 'utf-8' }).trim();
  } catch {}
  return 'claude';
}
const CLAUDE_BIN = findClaudeBin();
const LLM_PROMPT_TEMPLATE = path.join(__dirname, '../config/kmong-llm-prompt.md');

const requestId = process.argv[2];
const projectJsonFile = process.argv[3] || null;

if (!requestId) {
  console.error('Usage: node kmong-auto-phase1.js <requestId> [projectJsonFile]');
  process.exit(1);
}

// 프로젝트 정보 로드
async function loadProject() {
  console.log('[1/4] 📋 프로젝트 정보 로드...');

  if (projectJsonFile && fs.existsSync(projectJsonFile)) {
    const project = JSON.parse(fs.readFileSync(projectJsonFile, 'utf-8'));
    console.log(`✅ (파일: ${projectJsonFile})\n`);
    return project;
  }

  const raw = await findRequestById(requestId);
  if (!raw) throw new Error(`목록 API에서 프로젝트 ${requestId}를 찾을 수 없음 (마감/삭제 가능성)`);
  const project = {
    id: raw.id,
    title: raw.title || '',
    content: raw.content || '',
    amount: raw.amount ?? null,
    days: raw.days ?? null,
    projectType: raw.project_type || '',
    category: raw.breadcrumb || '',
  };
  console.log(`✅ (API 검색: ${project.title})\n`);
  return project;
}

// LLM 생성 (claude CLI 구독 사용 — API 키 불필요)
function generateWithClaude(project) {
  console.log('[2/4] 🤖 Claude (CLI 구독)...');

  const template = fs.readFileSync(LLM_PROMPT_TEMPLATE, 'utf-8');

  const amountText = project.amount
    ? `${Number(project.amount).toLocaleString('ko-KR')}원 (${Math.round(project.amount / 10000)}만원)`
    : '협의 (미지정)';
  const projectInfo = `제목: ${project.title}
카테고리: ${project.category || '미지정'}
예상 금액: ${amountText}
예상 기간: ${project.days ? project.days + '일' : '협의 (미지정)'}
진행 방식: ${project.projectType === 'RESIDENT' ? '상주' : '외주(도급)'}

${project.content}`.trim();

  const prompt = template.replace('{PROJECT_INFO}', projectInfo);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const tempDir = path.join(__dirname, '../temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  fs.writeFileSync(path.join(tempDir, `claude-prompt-${requestId}-${timestamp}.txt`), prompt);

  console.log(`   CLAUDE_BIN: ${CLAUDE_BIN}`);
  let responseText;
  try {
    responseText = execSync(
      `"${CLAUDE_BIN}" --print --max-turns 5 --model sonnet --tools ""`,
      {
        input: prompt,
        encoding: 'utf-8',
        maxBuffer: 20 * 1024 * 1024,
        timeout: 10 * 60 * 1000, // 10분
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: [
            (process.env.HOME || '') + '/.npm-global/bin',
            (process.env.HOME || '') + '/.local/bin',
            '/opt/homebrew/bin',
            '/usr/local/bin',
            '/usr/bin',
            '/bin',
            process.env.PATH,
          ].filter(Boolean).join(':'),
        },
      }
    );
  } catch (e) {
    throw new Error(`claude CLI 호출 실패: ${e.message.split('\n')[0]}`);
  }
  responseText = (responseText || '').trim();

  const responsePath = path.join(tempDir, `llm-response-${requestId}-${timestamp}.txt`);
  fs.writeFileSync(responsePath, responseText);

  console.log(`✅ (${responseText.length}자)`);
  console.log(`💾 LLM 응답: ${responsePath}\n`);

  return { responsePath, sections: parseLLMResponse(responseText) };
}

// LLM 응답을 섹션별로 파싱
function parseLLMResponse(llmText) {
  const sections = {
    design: '',   // 1. 디자인 프롬프트
    proposal: '', // 2. 제안 내용
    terms: '',    // 3. 제안 조건 (JSON)
  };

  const lines = llmText.split('\n');
  let currentSection = null;

  for (const line of lines) {
    if (line.match(/^##\s*1\.\s*(디자인|피그마)/)) {
      currentSection = 'design';
    } else if (line.match(/^##\s*2\.\s*제안\s*내용/)) {
      currentSection = 'proposal';
    } else if (line.match(/^##\s*3\.\s*제안\s*조건/)) {
      currentSection = 'terms';
    } else if (currentSection && !line.startsWith('##')) {
      sections[currentSection] += line + '\n';
    }
  }

  for (const key of Object.keys(sections)) {
    // LLM이 섹션 구분용으로 넣는 단독 '---' 줄 제거 (크몽 제안서에 마크다운 금지)
    sections[key] = sections[key]
      .replace(/^\s*-{3,}\s*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return sections;
}

// 제안 조건 JSON 파싱 (실패 시 목록 정보로 fallback)
function parseTerms(termsText, project) {
  let amountManwon = null;
  let days = null;

  const jsonMatch = (termsText || '').match(/\{[^{}]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Number.isFinite(Number(parsed.amount_manwon))) amountManwon = Math.round(Number(parsed.amount_manwon));
      if (Number.isFinite(Number(parsed.days))) days = Math.round(Number(parsed.days));
    } catch {}
  }

  // fallback: 목록 API 값
  if (!amountManwon && project.amount) amountManwon = Math.round(project.amount / 10000);
  if (!days && project.days) days = project.days;

  if (!amountManwon || amountManwon <= 0) throw new Error('제안 금액 산정 실패 (LLM 조건 JSON + 목록 금액 모두 없음)');
  if (!days || days <= 0) days = 60;

  return { amountManwon, days };
}

// 결과물 텍스트 파일 저장
function saveOutputFiles(sections, terms, project) {
  console.log('[4/4] 💾 결과물 저장...');

  const tempDir = path.join(__dirname, '../temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const files = {};

  if (sections.design) {
    files.designPrompt = path.join(tempDir, `kmong-${requestId}-design-prompt.txt`);
    fs.writeFileSync(files.designPrompt, sections.design);
  }

  if (sections.proposal) {
    files.proposalContent = path.join(tempDir, `kmong-${requestId}-proposal-content.txt`);
    fs.writeFileSync(files.proposalContent, sections.proposal);
  }

  files.terms = path.join(tempDir, `kmong-${requestId}-terms.json`);
  fs.writeFileSync(files.terms, JSON.stringify(terms, null, 2));

  const meta = {
    requestId,
    projectTitle: project.title,
    timestamp: new Date().toISOString(),
    terms,
    files,
  };
  files.meta = path.join(tempDir, `kmong-${requestId}-meta.json`);
  fs.writeFileSync(files.meta, JSON.stringify(meta, null, 2));

  console.log('✅ 저장 완료\n');
  return files;
}

// 메인
(async () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🤖 크몽 자동화 Phase 1');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const project = await loadProject();

  console.log(`📌 ${requestId}: ${project.title}\n`);

  const { responsePath, sections } = generateWithClaude(project);

  console.log('[3/4] 🔍 섹션 파싱...');
  if (!sections.proposal) throw new Error('LLM 응답에서 "## 2. 제안 내용" 섹션을 찾을 수 없음');
  if (!sections.design) throw new Error('LLM 응답에서 "## 1. 디자인 프롬프트" 섹션을 찾을 수 없음');
  const terms = parseTerms(sections.terms, project);
  console.log(`✅ (금액: ${terms.amountManwon}만원, 기간: ${terms.days}일)\n`);

  const files = saveOutputFiles(sections, terms, project);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ Phase 1 완료!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📌 프로젝트: ${requestId}`);
  console.log(`💾 LLM 응답: ${responsePath}`);
  console.log(`🎨 디자인 프롬프트: ${files.designPrompt || '없음'}`);
  console.log(`📝 제안 내용: ${files.proposalContent || '없음'}`);
  console.log(`💰 제안 조건: ${files.terms}`);
  console.log(`🗂  메타: ${files.meta}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // 스케줄러 파싱용 결과 출력
  console.log('PHASE1_RESULT:' + JSON.stringify({
    requestId,
    projectTitle: project.title,
    designPromptFile: files.designPrompt,
    proposalContentFile: files.proposalContent,
    termsFile: files.terms,
    metaFile: files.meta,
  }));
})().catch(err => {
  console.error(`❌ Phase 1 실패: ${err.message}`);
  process.exit(1);
});
