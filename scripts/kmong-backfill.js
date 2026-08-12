#!/usr/bin/env node

/**
 * 크몽 놓친 프로젝트 보충 지원 (backfill)
 *
 * 스케줄러가 꺼져 있던 동안(세션 만료·컴퓨터 종료 등) 지나간 공고를 한 번에 따라잡는다.
 * 정규 스케줄러는 최신 1페이지(20개)만 훑지만, 이 스크립트는 여러 페이지를 훑어
 * seen 에 없는 = 아직 지원 안 한 공고를 찾아낸다.
 *
 * 안전장치 (크몽 "단시간 대량 제안" 제재 방지 — README 정책 주의사항):
 *   - 기본은 dry-run: 실제 제출 없이 "놓친 후보" 목록만 출력한다.
 *   - --submit 를 줘야 실제 제안 제출. 그때도:
 *       · 스케줄러와 동일한 필터(shouldSkip: 상주/UIUX/개발무관/제안수 상한) 적용
 *       · 프로젝트 간 delayBetweenProjectsSec(기본 30초) 대기
 *       · --limit(기본 10) 로 1회 제출 건수 상한 → 나눠서 실행 유도
 *   - 성공/필터스킵 → seen 추가(재지원 방지), 실패 → seen 미추가(다음에 재시도)
 *     이 규칙은 재사용하는 kmong-scheduler.processProject 가 그대로 처리한다.
 *
 * Usage:
 *   node scripts/kmong-backfill.js                 # dry-run, 3페이지 훑어 놓친 후보 표시
 *   node scripts/kmong-backfill.js --pages 5       # 5페이지까지 훑기
 *   node scripts/kmong-backfill.js --submit        # 실제 제출 (최대 10건)
 *   node scripts/kmong-backfill.js --submit --limit 3
 *   node scripts/kmong-backfill.js --submit --no-prototype                 # 시제품 생성 건너뜀(가장 안정적)
 *   node scripts/kmong-backfill.js --submit --no-prototype --portfolio "https://내포트폴리오"
 *
 * --no-prototype: 잘 깨지는 Phase 2(claude.ai 시제품 자동생성)를 건너뛰고 제안서만으로
 *   제출한다. claude.ai UI 의존성이 사라져 성공률이 높다. --portfolio 를 주면 제안서
 *   맨 위 "시제품 미리보기" 링크가 그 URL 로 채워지고, 없으면 그 줄은 제거된다.
 *
 * 기본 제출(--submit)은 세션(kmong-login-cookie.js) + claude CLI (+ 시제품 모드면
 * claude.ai + R2)가 갖춰진 환경(보통 로컬 맥)에서만 동작한다. dry-run 은 공개 API 만 쓴다.
 */

const fs = require('fs');
const path = require('path');
const { fetchRequestList, requestUrl } = require('../lib/kmong-api');
const { WORKSPACE } = require('../lib/workspace');
const {
  processProject,
  shouldSkip,
  loadSeen,
  saveSeen,
} = require('./kmong-scheduler');

const CONFIG_FILE = path.join(WORKSPACE, 'config/kmong.config.json');
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch { return {}; }
}
const CONFIG = loadConfig();

function parseArgs(argv) {
  const args = { pages: 3, submit: false, limit: 10, noPrototype: false, portfolio: '', includeResident: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--submit') args.submit = true;
    else if (a === '--pages') args.pages = Number(argv[++i]) || args.pages;
    else if (a === '--limit') args.limit = Number(argv[++i]) || args.limit;
    else if (a === '--no-prototype') args.noPrototype = true;
    else if (a === '--portfolio') args.portfolio = argv[++i] || '';
    else if (a === '--include-resident') args.includeResident = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function fmtAmount(amount) {
  if (!amount) return '협의';
  return `${Math.round(amount / 10000).toLocaleString('ko-KR')}만원`;
}

// 공개 API 응답을 스케줄러/필터가 기대하는 project 모양으로 변환 (kmong-scraper 와 동일)
function toProject(r) {
  return {
    id: r.id,
    link: requestUrl(r.id),
    title: r.title || '',
    content: r.content || '',
    amount: r.amount ?? null,
    days: r.days ?? null,
    deadline: r.deadline ?? null,
    proposalCount: r.proposal_count ?? 0,
    projectType: r.project_type || '',
    businessType: r.business_type || '',
    isGovernment: !!r.is_government,
    category: r.breadcrumb || (r.category ? `${r.category.cat1_name} / ${r.category.cat2_name}` : ''),
    status: r.status || '',
  };
}

async function scrapePages(pages, categoryList) {
  const all = [];
  for (let page = 1; page <= pages; page++) {
    const data = await fetchRequestList({ categoryList, page, perPage: 20 });
    for (const r of data.requests || []) all.push(toProject(r));
    if (page >= (data.last_page || 1)) break;
  }
  // id 중복 제거 (페이지 경계 이동으로 중복 노출될 수 있음)
  const seen = new Set();
  return all.filter(p => p.id && !seen.has(p.id) && seen.add(p.id));
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: node scripts/kmong-backfill.js [--pages N] [--submit] [--limit N] [--no-prototype] [--portfolio URL] [--include-resident]');
    console.log('  --include-resident : 상주(RESIDENT) 공고도 지원 대상에 포함 (기본은 외주만)');
    process.exit(0);
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📥 크몽 놓친 프로젝트 보충 (${args.submit ? '제출 모드' : 'dry-run'})`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const categoryList = CONFIG.categoryList || '6';
  console.log(`🔎 카테고리 ${categoryList} 에서 ${args.pages}페이지 수집 중...`);
  const projects = await scrapePages(args.pages, categoryList);
  console.log(`   총 ${projects.length}개 공고 확인\n`);

  // 수집 공고의 진행방식 분포 — 상주만 잔뜩 올라온 시기엔 "지원 대상 0건"이 정상 동작이다.
  // 그 사실을 로그로 바로 보여줘서 세션 문제로 오해하지 않게 한다.
  const typeCount = projects.reduce((acc, p) => {
    const k = p.projectType || '(미상)';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  console.log(`   진행방식 분포: ${Object.entries(typeCount).map(([k, v]) => `${k === 'RESIDENT' ? '상주' : k === 'OUTSOURCING' ? '외주' : k} ${v}건`).join(', ')}\n`);

  // 허용 진행방식 — --include-resident 면 상주까지 포함
  const filterOpts = args.includeResident ? { projectTypes: ['OUTSOURCING', 'RESIDENT'] } : {};
  console.log(`⚙️  허용 진행방식: ${(filterOpts.projectTypes || CONFIG.projectTypes || ['OUTSOURCING']).map(t => t === 'RESIDENT' ? '상주' : '외주').join(' + ')}\n`);

  const seenData = loadSeen();
  const seenIds = new Set((seenData.projects || []).map(String));

  // 아직 지원 안 한 것(=놓친 후보) 중 필터 통과분
  const notSeen = projects.filter(p => !seenIds.has(String(p.id)));
  const eligible = [];
  const skipped = [];
  for (const p of notSeen) {
    const { skip, reason } = shouldSkip(p, filterOpts);
    if (skip) skipped.push({ p, reason });
    else eligible.push(p);
  }

  console.log(`🆕 미지원 공고: ${notSeen.length}개  →  ✅ 지원 대상: ${eligible.length}개, ⏭️  필터 제외: ${skipped.length}개\n`);

  // 제외 사유별 집계 — 어디서 다 걸러졌는지 한눈에
  if (skipped.length) {
    const byReason = skipped.reduce((acc, s) => {
      const key = s.reason.replace(/"[^"]*"/, '...').replace(/\d+/g, 'N');
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    console.log('── 제외 사유 ──');
    Object.entries(byReason).sort((a, b) => b[1] - a[1])
      .forEach(([reason, n]) => console.log(`   ${n}건: ${reason}`));
    console.log('');
  }

  if (eligible.length) {
    console.log('── 지원 대상 (놓친 프로젝트) ──');
    eligible.forEach((p, i) => {
      const dday = p.deadline != null ? `D-${p.deadline}` : '마감미상';
      console.log(`${String(i + 1).padStart(2)}. [${p.id}] ${p.title}`);
      console.log(`    ${fmtAmount(p.amount)} / ${p.days ? p.days + '일' : '기간협의'} / 제안 ${p.proposalCount}건 / ${dday}`);
      console.log(`    ${p.link}`);
    });
    console.log('');
  } else {
    console.log('ℹ️  필터를 통과한 놓친 프로젝트가 없습니다.\n');
  }

  // 미리보기 결과를 파일로도 남김
  const tempDir = path.join(WORKSPACE, 'temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const outFile = path.join(tempDir, 'kmong-backfill-candidates.json');
  fs.writeFileSync(outFile, JSON.stringify({ eligible, skipped: skipped.map(s => ({ id: s.p.id, title: s.p.title, reason: s.reason })) }, null, 2));
  console.log(`💾 후보 목록 저장: ${outFile}\n`);

  if (!args.submit) {
    console.log('👉 실제 지원하려면: node scripts/kmong-backfill.js --submit  (한 번에 최대 --limit 건)');
    console.log('   가장 안정적: node scripts/kmong-backfill.js --submit --no-prototype  (시제품 생성 건너뜀)');
    console.log('   ⚠️ 제출 전 반드시 세션 복구: node scripts/kmong-login-cookie.js "<kmong_session>"');
    process.exit(0);
  }

  // ── 제출 모드 ──
  if (!eligible.length) {
    console.log('제출할 대상이 없습니다.');
    process.exit(0);
  }

  const batch = eligible.slice(0, args.limit);
  const delaySec = Number(CONFIG.delayBetweenProjectsSec) || 30;

  // 제출 옵션 — 플래그가 있으면 그 값, 없으면 processProject 가 config 로 폴백
  const submitOpts = { ...filterOpts };
  if (args.noPrototype) submitOpts.skipPrototype = true;
  if (args.portfolio) submitOpts.portfolioUrl = args.portfolio;
  const protoMode = (args.noPrototype || CONFIG.skipPrototype === true)
    ? `OFF (제안서만${(args.portfolio || CONFIG.portfolioUrl) ? ' + 포트폴리오 링크' : ''})`
    : 'ON (claude.ai 시제품 자동생성)';

  console.log(`🚀 제출 시작: ${batch.length}건 (전체 ${eligible.length}건 중 --limit ${args.limit}), 간격 ${delaySec}초`);
  console.log(`   시제품(Phase 2): ${protoMode}\n`);
  if (eligible.length > batch.length) {
    console.log(`ℹ️  ${eligible.length - batch.length}건은 이번 회차 제외 — 나중에 다시 실행하거나 --limit 을 높이세요.\n`);
  }

  for (let i = 0; i < batch.length; i++) {
    const project = batch[i];
    console.log(`\n[${i + 1}/${batch.length}] 처리 중: [${project.id}] ${project.title}`);
    // 스케줄러와 동일한 seen/실패 규칙으로 1건 처리 (Phase 1~3)
    await processProject(project, seenData, submitOpts);
    if (i < batch.length - 1) {
      console.log(`⏳ ${delaySec}초 대기...`);
      await new Promise(r => setTimeout(r, delaySec * 1000));
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ backfill 제출 회차 완료');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  // seenData 는 processProject 내부에서 매 건 저장되므로 별도 저장 불필요
}

main().catch(err => {
  console.error(`❌ backfill 실패: ${err.message}`);
  process.exit(1);
});
