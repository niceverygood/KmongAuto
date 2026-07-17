#!/usr/bin/env node

/**
 * 크몽 자동화 Phase 1
 *
 * 1. 스크래핑 (공개 JSON API)
 * 2. 신규 체크
 * 3. 상세 수집 (공개 JSON API — 로그인/브라우저 불필요)
 * 4. Claude LLM 생성
 * 5. 결과물 텍스트 저장 (시제품 프롬프트, 제안 내용, 포트폴리오 각각 파일로)
 *
 * 크몽 커스텀 프로젝트 게시판은 댓글 기능이 없으므로 위시켓 봇의 "지원 댓글" 섹션은 없다.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// claude CLI 경로 자동 탐색 (구독 사용, API 키 불필요)
function findClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const home = process.env.HOME || `/Users/${process.env.USER || 'domo'}`;
  const candidates = [
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
const SEEN_FILE = path.join(__dirname, '../data/kmong-seen.json');
const LLM_PROMPT_TEMPLATE = path.join(__dirname, '../config/kmong-llm-prompt.md');

// 특정 프로젝트 ID 지정 시 해당 프로젝트만 처리
const FORCE_PROJECT_ID = process.argv[2] || null;

function loadSeen() {
  if (!fs.existsSync(SEEN_FILE)) return { projects: [] };
  return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf-8'));
}

function saveSeen(data) {
  const dir = path.dirname(SEEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify(data, null, 2));
}

function extractProjectId(link) {
  const match = link.match(/\/custom-project\/requests\/(\d+)/);
  return match ? match[1] : null;
}

// 1. 스크래핑
async function scrapeProjects() {
  console.log('[1/5] 📋 스크래핑...');
  const result = execSync(`node ${path.join(__dirname, 'kmong-scraper.js')}`, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024
  });
  const projects = JSON.parse(result);
  console.log(`✅ ${projects.length}개\n`);
  return projects;
}

// 2. 신규 체크
function filterNewProjects(projects) {
  console.log('[2/5] 🆕 신규 체크...');
  const seenData = loadSeen();
  const seenIds = new Set((seenData.projects || []).map(String));

  if (FORCE_PROJECT_ID) {
    const target = projects.find(p => String(p.id) === String(FORCE_PROJECT_ID));
    if (target) {
      console.log(`✅ 강제 처리: ${FORCE_PROJECT_ID}\n`);
      return { newProjects: [target], seenData, seenIds };
    }
    console.log(`✅ 강제 처리 (리스트 외): ${FORCE_PROJECT_ID}\n`);
    return {
      newProjects: [{
        id: FORCE_PROJECT_ID,
        link: `https://kmong.com/custom-project/requests/${FORCE_PROJECT_ID}`,
        title: ''
      }],
      seenData,
      seenIds
    };
  }

  const newProjects = projects.filter(p => {
    return p.status === 'APPROVAL' && !seenIds.has(String(p.id));
  });

  console.log(`✅ ${newProjects.length}개\n`);
  return { newProjects, seenData, seenIds };
}

// 3. 상세 수집 (공개 JSON API 직접 호출 — 로그인 불필요)
async function getProjectDetail(projectId) {
  console.log('[3/5] 📝 상세 (API)...');

  const url = `https://kmong.com/api/custom-project/v1/requests/${projectId}`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`상세 API 실패: HTTP ${res.status}`);
  const data = await res.json();

  // 비공개(매칭 전용) 프로젝트는 건너뜀 — 위시켓의 "프라이밋 매칭 프로젝트"에 대응
  if (data.is_confidential) {
    console.log('⏭️  비공개(컴피덴셔션) 프로젝트 - 건너뜀\n');
    return null;
  }

  const answerLines = (data.answers || []).map(a => {
    const val = a.type === 'ITEMS' ? (a.contents || []).join(', ') : (a.description || '');
    return val ? `${a.title}: ${val}` : null;
  }).filter(Boolean);

  const detail = {
    title: data.title || '',
    amount: data.amount || 0,
    deadline: data.deadline,
    isTax: data.is_tax,
    businessType: data.business_type,
    breadcrumb: data.breadcrumb || '',
    description: data.description || '',
    answerLines,
  };

  console.log(`✅ (금액: ${detail.amount.toLocaleString()}원, 분류: ${detail.breadcrumb})\n`);
  return detail;
}

// 4. LLM 생성 (claude CLI 구독 사용 — API 키 불필요)
async function generateWithClaude(projectInfo, projectId) {
  console.log('[4/5] 🤖 Claude (CLI 구독)...');

  const template = fs.readFileSync(LLM_PROMPT_TEMPLATE, 'utf-8');
  const prompt = template.replace('{PROJECT_INFO}', projectInfo);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const tempDir = path.join(__dirname, '../temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const promptPath = path.join(tempDir, `claude-prompt-${projectId}-${timestamp}.txt`);
  fs.writeFileSync(promptPath, prompt);

  console.log(`   CLAUDE_BIN: ${CLAUDE_BIN}`);
  let responseText;
  try {
    responseText = execSync(
      `"${CLAUDE_BIN}" --print --max-turns 5 --model sonnet --tools ""`,
      {
        input: prompt,
        encoding: 'utf-8',
        maxBuffer: 20 * 1024 * 1024,
        timeout: 10 * 60 * 1000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: [
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

  const responsePath = path.join(tempDir, `llm-response-${projectId}-${timestamp}.txt`);
  fs.writeFileSync(responsePath, responseText);

  console.log(`✅ (${responseText.length}자)\n`);
  console.log(`💾 LLM 응답: ${responsePath}\n`);

  return {
    llmResponsePath: responsePath,
    sections: parseLLMResponse(responseText)
  };
}

// LLM 응답을 섹션별로 파싱 (크몽은 댓글 섹션 없음 — 3개 섹션)
function parseLLMResponse(llmText) {
  const sections = {
    prototype: '',   // 1. 시제품 프롬프트
    proposal: '',    // 2. 제안 내용
    portfolio: '',   // 3. 포트폴리오 설명
  };

  const lines = llmText.split('\n');
  let currentSection = null;

  for (const line of lines) {
    if (line.match(/^##\s*1\.\s*시제품/)) {
      currentSection = 'prototype';
    } else if (line.match(/^##\s*2\.\s*제안\s*내용/)) {
      currentSection = 'proposal';
    } else if (line.match(/^##\s*3\.\s*포트폴리오/)) {
      currentSection = 'portfolio';
    } else if (currentSection && !line.startsWith('##')) {
      sections[currentSection] += line + '\n';
    }
  }

  for (const key of Object.keys(sections)) {
    sections[key] = sections[key].trim();
  }

  return sections;
}

// 5. 결과물 텍스트 파일 저장
function saveOutputFiles(sections, projectId, projectTitle) {
  console.log('[5/5] 💾 결과물 저장...');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const tempDir = path.join(__dirname, '../temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const files = {};

  if (sections.prototype) {
    files.prototypePrompt = path.join(tempDir, `kmong-${projectId}-prototype-prompt.txt`);
    fs.writeFileSync(files.prototypePrompt, sections.prototype);
  }

  if (sections.proposal) {
    files.proposalContent = path.join(tempDir, `kmong-${projectId}-proposal-content.txt`);
    fs.writeFileSync(files.proposalContent, sections.proposal);
  }

  if (sections.portfolio) {
    files.portfolio = path.join(tempDir, `kmong-${projectId}-portfolio.txt`);
    fs.writeFileSync(files.portfolio, sections.portfolio);
  }

  const meta = { projectId, projectTitle, timestamp, files };
  files.meta = path.join(tempDir, `kmong-${projectId}-meta.json`);
  fs.writeFileSync(files.meta, JSON.stringify(meta, null, 2));

  console.log(`✅ 저장 완료\n`);
  return files;
}

(async () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🤖 크몽 자동화 Phase 1');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  try {
    const projects = await scrapeProjects();
    const { newProjects, seenData, seenIds } = filterNewProjects(projects);

    if (newProjects.length === 0) {
      console.log('ℹ️  신규 없음\n');
      return;
    }

    const projectsToProcess = newProjects.slice(0, 1);

    for (const project of projectsToProcess) {
      const projectId = String(project.id || extractProjectId(project.link));

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`📌 ${projectId}: ${project.title || '(제목 로딩 중)'}`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      try {
        const detail = await getProjectDetail(projectId);

        if (detail === null) {
          // 비공개/삭제된 프로젝트 — 재시도해도 결과가 같으므로 seen에 기록
          // (강제 처리 모드에선 seen 수명주기를 스케줄러가 소유하므로 건드리지 않음)
          if (!FORCE_PROJECT_ID) {
            seenIds.add(projectId);
            seenData.projects = Array.from(seenIds);
            saveSeen(seenData);
          }
          continue;
        }

        const projectInfo = `제목: ${detail.title || project.title}
분류: ${detail.breadcrumb}
예상 금액: ${detail.amount ? detail.amount.toLocaleString() + '원' : '협의'}
세금계산서: ${detail.isTax ? '발행 가능' : '발행 불가'}

${detail.answerLines.join('\n')}

[프로젝트 설명]
${detail.description}`.trim();

        const { llmResponsePath, sections } = await generateWithClaude(projectInfo, projectId);

        const files = saveOutputFiles(sections, projectId, detail.title || project.title);

        // 강제 처리(스케줄러가 projectId를 지정해 호출) 모드에서는 seen을 저장하지 않는다.
        // Phase 2/3까지 성공했을 때만 스케줄러가 seen에 추가해야 실패 건이 다음 회차에
        // 재시도된다 — 여기서 미리 저장하면 "seen 미추가 재시도" 약속이 깨진다.
        if (!FORCE_PROJECT_ID) {
          seenIds.add(projectId);
          seenData.projects = Array.from(seenIds);
          saveSeen(seenData);
        }

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ Phase 1 완료!');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`📌 프로젝트: ${projectId}`);
        console.log(`💾 LLM 응답: ${llmResponsePath}`);
        console.log(`🎨 시제품 프롬프트: ${files.prototypePrompt || '없음'}`);
        console.log(`📝 제안 내용: ${files.proposalContent || '없음'}`);
        console.log(`📋 포트폴리오: ${files.portfolio || '없음'}`);
        console.log(`🗂  메타: ${files.meta}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        console.log('PHASE1_RESULT:' + JSON.stringify({
          projectId,
          projectTitle: detail.title || project.title,
          prototypePromptFile: files.prototypePrompt,
          proposalContentFile: files.proposalContent,
          portfolioFile: files.portfolio,
          metaFile: files.meta,
          // 제안서 섹션 없이 LLM 응답만 있으면 "역량 불일치 등으로 작성을 거부한 것" —
          // 스케줄러가 재시도 불가 스킵으로 분류할 수 있도록 응답 경로를 넘긴다.
          llmResponseFile: llmResponsePath
        }));

      } catch (error) {
        console.error(`❌ ${projectId} 실패: ${error.message}\n`);
      }

      await new Promise(resolve => setTimeout(resolve, 2000));
    }

  } catch (error) {
    console.error(`❌ 전체 실패: ${error.message}`);
  }
})();
