#!/usr/bin/env node

/**
 * 크몽 자동지원 진단기 (kmong-doctor)
 *
 * "자동지원이 왜 안 되는가" 를 한 번에 특정한다.
 * 사람이 여러 명령을 돌려보고 눈으로 대조할 필요 없이,
 * 파이프라인이 실제로 끊기는 지점을 찾아 결론을 찍어준다.
 *
 * 검사 항목:
 *   1. 설정 (config/kmong.config.json)
 *   2. 전체 카테고리 스캔 — 어떤 카테고리가 존재하고, 지금 설정이 뭘 놓치고 있는지
 *   3. 현재 설정으로 실제 수집되는 공고 수
 *   4. seen 대조 → 신규 건수
 *   5. 필터 시뮬레이션 → 건별 통과/스킵 사유
 *   6. 브라우저 프로필의 크몽 로그인 세션 생존 여부
 *
 * Usage:
 *   node scripts/kmong-doctor.js                 # 전체 진단
 *   node scripts/kmong-doctor.js --no-browser    # 세션 검사 생략 (빠름)
 *   node scripts/kmong-doctor.js --pages 3       # 카테고리 스캔 페이지 수 (기본 2)
 *   node scripts/kmong-doctor.js --find 키오스크  # 특정 공고가 왜 안 잡히는지 추적
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(WORKSPACE, 'config/kmong.config.json');
const SEEN_FILE = path.join(WORKSPACE, 'data/kmong-seen.json');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const argv = process.argv.slice(2);
const noBrowser = argv.includes('--no-browser');
const scanPages = Number(argv[argv.indexOf('--pages') + 1]) || 2;
const findTerm = argv.includes('--find') ? argv[argv.indexOf('--find') + 1] : null;

// ─────────────────────────────────────────────────────────────
// 스케줄러의 필터 규칙 사본
// ⚠️ kmong-scheduler.js 의 SKIP_KEYWORDS / INCLUDE_KEYWORDS 와 동일해야 의미가 있다.
//    스케줄러를 수정했다면 여기도 맞춰야 진단이 정확하다.
// ─────────────────────────────────────────────────────────────
const SKIP_KEYWORDS = [
  'UI/UX', 'UI/ UX', 'UX/UI', 'UX 디자인', 'UI 디자인',
  '디자인 기획', '기획만', '기획 전문', 'UX 기획',
  '서비스 기획', '기획서 작성', '앱 기획', '웹 기획',
  '화면설계', '스토리보드', '와이어프레임', '프로토타입 기획',
  'IA 설계', '정보구조', '그래픽 디자인', '브랜딩 디자인',
  '로고 디자인', '배너 디자인', '영상 편집', '영상 제작',
  '모션 그래픽', '일러스트', '캐릭터 디자인',
];

const INCLUDE_KEYWORDS = [
  '개발', '구축', '제작', 'API', '앱 개발', '웹 개발',
  '백엔드', '프론트엔드', 'Flutter', 'React', 'Next.js',
  'Spring', 'Node', 'Python', 'Java', 'Swift', 'Kotlin',
  '자동화', '크롤링', 'AI', '머신러닝', '데이터',
  '플랫폼', '시스템', '솔루션', '서버', '홈페이지', '쇼핑몰',
];

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};

const findings = []; // { level: 'error'|'warn'|'info', msg, fix }
const addFinding = (level, msg, fix) => findings.push({ level, msg, fix });

function hr(title) {
  console.log('');
  console.log(C.b(`━━ ${title} ${'━'.repeat(Math.max(0, 58 - title.length))}`));
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

async function fetchList({ categoryList, projectType, page = 1, perPage = 50 }) {
  const params = new URLSearchParams({
    sort: 'CREATED_AT',
    page: String(page),
    per_page: String(perPage),
  });
  if (categoryList) params.set('category_list', categoryList);
  if (projectType) params.set('project_type', projectType);

  const url = `https://kmong.com/api/custom-project/v1/requests?${params}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`크몽 목록 API HTTP ${res.status}`);
  return res.json();
}

/** 스케줄러의 shouldSkip 과 동일한 판정 */
function judge(project, config) {
  const allowedTypes = config.projectTypes || ['OUTSOURCING'];
  if (project.project_type && !allowedTypes.includes(project.project_type)) {
    return { skip: true, reason: `진행 방식 제외: ${project.project_type}` };
  }
  const t = project.title || '';
  for (const kw of SKIP_KEYWORDS) {
    if (t.includes(kw)) return { skip: true, reason: `스킵 키워드: "${kw}"` };
  }
  const haystack = t + ' ' + (project.content || '').slice(0, 400);
  if (!INCLUDE_KEYWORDS.some((kw) => haystack.includes(kw))) {
    return { skip: true, reason: '개발 관련 키워드 없음' };
  }
  const maxProposals = Number(config.maxProposalCount) || 999;
  if ((project.proposal_count || 0) > maxProposals) {
    return { skip: true, reason: `제안 ${project.proposal_count}건 > 상한 ${maxProposals}` };
  }
  return { skip: false };
}

const catKey = (r) => (r.category ? `${r.category.cat1}` : '?');
const catName = (r) => (r.category ? r.category.cat1_name : '?');

(async () => {
  console.log(C.b('\n╔══════════════════════════════════════════════════════════╗'));
  console.log(C.b('║        크몽 자동지원 진단기 (kmong-doctor)               ║'));
  console.log(C.b('╚══════════════════════════════════════════════════════════╝'));
  console.log(C.dim(`실행: ${new Date().toLocaleString('ko-KR')}`));
  console.log(C.dim(`작업 폴더: ${WORKSPACE}`));

  // ── 1. 설정 ────────────────────────────────────────────────
  hr('1. 설정');
  if (!fs.existsSync(CONFIG_FILE)) {
    console.log(C.bad(`✗ 설정 파일 없음: ${CONFIG_FILE}`));
    addFinding('error', '설정 파일이 없습니다', `${CONFIG_FILE} 생성 필요`);
    process.exit(1);
  }
  const config = loadJson(CONFIG_FILE, {});
  const configuredCats = String(config.categoryList ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(`  수집 카테고리 : ${configuredCats.length ? configuredCats.join(', ') : C.warn('(미지정 → 전체)')}`);
  console.log(`  수집 페이지   : ${config.scrapePages ?? 1}`);
  console.log(`  진행 방식     : ${(config.projectTypes || ['OUTSOURCING']).join(', ')}`);
  console.log(`  최소 금액     : ${config.minAmountManwon ?? 0}만원`);
  console.log(`  제안수 상한   : ${config.maxProposalCount ?? 999}`);

  // ── 2. 전체 카테고리 스캔 ──────────────────────────────────
  hr('2. 전체 카테고리 스캔 (설정 무시하고 전부 조회)');
  let all = [];
  try {
    for (let p = 1; p <= scanPages; p++) {
      const data = await fetchList({ page: p, perPage: 50 });
      all.push(...(data.requests || []));
      if (p >= (data.last_page || 1)) break;
    }
  } catch (e) {
    console.log(C.bad(`✗ 크몽 목록 API 실패: ${e.message}`));
    addFinding('error', `크몽 목록 API 호출 실패: ${e.message}`, '네트워크/방화벽 확인');
    all = [];
  }

  const byCat = new Map(); // cat1 -> { name, total, wouldPass }
  for (const r of all) {
    const k = catKey(r);
    if (!byCat.has(k)) byCat.set(k, { name: catName(r), total: 0, pass: 0 });
    const e = byCat.get(k);
    e.total++;
    if (!judge(r, config).skip) e.pass++;
  }

  if (all.length) {
    console.log(`  최근 ${all.length}건에서 발견된 카테고리:\n`);
    console.log(`  ${'ID'.padEnd(6)} ${'카테고리'.padEnd(22)} ${'공고'.padStart(4)} ${'필터통과'.padStart(6)}  수집여부`);
    console.log(`  ${'─'.repeat(62)}`);
    const rows = [...byCat.entries()].sort((a, b) => b[1].total - a[1].total);
    for (const [id, e] of rows) {
      const collected = configuredCats.length === 0 || configuredCats.includes(id);
      const mark = collected ? C.ok('수집함') : C.bad('수집 안 함 ←');
      console.log(
        `  ${String(id).padEnd(6)} ${e.name.padEnd(22)} ${String(e.total).padStart(4)} ${String(e.pass).padStart(6)}  ${mark}`
      );
    }

    // 놓치고 있는 기회 계산
    const missed = rows
      .filter(([id]) => configuredCats.length > 0 && !configuredCats.includes(id))
      .reduce((acc, [, e]) => acc + e.pass, 0);
    if (missed > 0) {
      const missedCats = rows
        .filter(([id, e]) => configuredCats.length > 0 && !configuredCats.includes(id) && e.pass > 0)
        .map(([id, e]) => `${id}(${e.name})`);
      console.log('');
      console.log(
        C.warn(`  ⚠ 카테고리 설정 때문에 필터를 통과할 공고 ${missed}건을 놓치고 있습니다.`)
      );
      addFinding(
        'warn',
        `카테고리 미포함으로 지원 가능 공고 ${missed}건 누락 (${missedCats.join(', ')})`,
        `config/kmong.config.json 의 categoryList 를 "${[...configuredCats, ...missedCats.map((s) => s.split('(')[0])].join(',')}" 로 변경`
      );
    }
  }

  // ── 3. 현재 설정으로 수집 ──────────────────────────────────
  hr('3. 현재 설정으로 실제 수집되는 공고');
  let collected = [];
  try {
    const pages = Number(config.scrapePages) || 1;
    for (let p = 1; p <= pages; p++) {
      const data = await fetchList({
        categoryList: config.categoryList || '',
        page: p,
        perPage: 20,
      });
      collected.push(...(data.requests || []));
      if (p >= (data.last_page || 1)) break;
    }
    console.log(`  수집: ${C.b(String(collected.length))}건`);
    if (collected.length === 0) {
      console.log(C.bad('  ✗ 한 건도 수집되지 않습니다 — 카테고리 설정이 잘못됐을 가능성이 큽니다.'));
      addFinding('error', '현재 설정으로 수집되는 공고가 0건', 'categoryList 값 확인');
    }
  } catch (e) {
    console.log(C.bad(`  ✗ 수집 실패: ${e.message}`));
  }

  // ── 4. seen 대조 ──────────────────────────────────────────
  hr('4. seen 대조 (이미 처리한 공고 제외)');
  const seen = loadJson(SEEN_FILE, { projects: [] });
  const seenIds = new Set((seen.projects || []).map(String));
  console.log(`  seen 기록: ${seenIds.size}건  (${fs.existsSync(SEEN_FILE) ? SEEN_FILE : '파일 없음'})`);
  const fresh = collected.filter((r) => !seenIds.has(String(r.id)));
  console.log(`  신규: ${C.b(String(fresh.length))}건`);
  if (collected.length > 0 && fresh.length === 0) {
    console.log(C.warn('  ⚠ 수집은 되는데 전부 seen 처리돼 있습니다 → 새 공고가 없거나, 과거에 스킵 처리됨'));
    addFinding('info', '신규 공고 0건 (전부 seen)', 'data/kmong-seen.json 에서 해당 ID 제거 시 재처리 가능');
  }

  // ── 5. 필터 시뮬레이션 ────────────────────────────────────
  hr('5. 필터 시뮬레이션 (신규 건별 판정)');
  if (fresh.length === 0) {
    console.log(C.dim('  판정할 신규 공고가 없습니다.'));
  } else {
    let passCount = 0;
    for (const r of fresh) {
      const v = judge(r, config);
      const amountManwon = r.amount ? Math.round(r.amount / 10000) : null;
      const minAmt = Number(config.minAmountManwon) || 0;
      let line;
      if (v.skip) {
        line = `  ${C.bad('SKIP')} ${r.id}  ${(r.title || '').slice(0, 40)}  ${C.dim('← ' + v.reason)}`;
      } else if (amountManwon !== null && amountManwon < minAmt) {
        line = `  ${C.warn('STOP')} ${r.id}  ${(r.title || '').slice(0, 40)}  ${C.dim(`← 금액 ${amountManwon}만원 < 최소 ${minAmt}만원 (Phase 3에서 중단)`)}`;
      } else {
        passCount++;
        line = `  ${C.ok('PASS')} ${r.id}  ${(r.title || '').slice(0, 40)}`;
      }
      console.log(line);
    }
    console.log('');
    console.log(`  → 지원 시도 대상: ${C.b(String(passCount))}건`);
    if (passCount === 0) {
      addFinding('warn', '신규 공고가 전부 필터에서 걸러짐', '필터 키워드 또는 minAmountManwon 재검토');
    }
  }

  // ── 특정 공고 추적 ────────────────────────────────────────
  if (findTerm) {
    hr(`추적: "${findTerm}"`);
    const hits = all.filter((r) => (r.title || '').includes(findTerm));
    if (!hits.length) {
      console.log(C.bad(`  ✗ 최근 ${all.length}건 안에 "${findTerm}" 를 포함한 공고가 없습니다.`));
      console.log(C.dim('    → --pages 를 늘려 더 많이 조회하거나, 이미 마감된 공고일 수 있습니다.'));
    }
    for (const r of hits) {
      const id = catKey(r);
      const inCat = configuredCats.length === 0 || configuredCats.includes(id);
      const v = judge(r, config);
      const amountManwon = r.amount ? Math.round(r.amount / 10000) : null;
      console.log(`  ${C.b(String(r.id))}  ${r.title}`);
      console.log(`    카테고리 : ${id} (${catName(r)})  → ${inCat ? C.ok('수집 대상') : C.bad('수집 대상 아님 ← 여기서 탈락')}`);
      console.log(`    진행방식 : ${r.project_type}`);
      console.log(`    금액     : ${amountManwon !== null ? amountManwon + '만원' : '협의'}`);
      console.log(`    필터     : ${v.skip ? C.bad('스킵 — ' + v.reason) : C.ok('통과')}`);
      console.log(`    seen     : ${seenIds.has(String(r.id)) ? C.warn('이미 처리됨') : C.ok('미처리')}`);
    }
  }

  // ── 6. 브라우저 세션 ──────────────────────────────────────
  hr('6. 봇 브라우저 프로필의 크몽 로그인 세션');
  if (noBrowser) {
    console.log(C.dim('  --no-browser 지정 — 생략'));
  } else {
    let browserLib = null;
    try {
      browserLib = require('../lib/browser');
    } catch (e) {
      console.log(C.warn(`  lib/browser.js 로드 실패 (${e.message}) — 세션 검사 생략`));
    }
    if (browserLib) {
      let ctx = null;
      try {
        ctx = await browserLib.browserStart('kmong', { headless: true });
        const page = await ctx.newPage();
        await page.goto('https://kmong.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await new Promise((r) => setTimeout(r, 2000));
        const me = await page.evaluate(async () => {
          const res = await fetch('/api/msa/user-app/user/v1/users/me', {
            credentials: 'include',
            headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          });
          const text = await res.text();
          let json = null;
          try { json = JSON.parse(text); } catch (_) {}
          return { status: res.status, json };
        });
        if (me.status === 200 && me.json) {
          const name = me.json.username || me.json.user?.username || '(이름 확인 불가)';
          console.log(C.ok(`  ✓ 로그인 유지됨 — ${name}`));
        } else {
          console.log(C.bad(`  ✗ 세션 없음/만료 (users/me HTTP ${me.status})`));
          console.log(C.dim('    ※ 일반 Chrome 에서 로그인돼 있어도 소용없습니다 —'));
          console.log(C.dim('       봇은 .browser-profiles/kmong 라는 별도 프로필을 씁니다.'));
          addFinding(
            'error',
            '봇 브라우저 프로필의 크몽 세션이 만료됨 → Phase 3 제출 불가',
            'node scripts/login-kmong.js 실행 후 뜨는 창에서 로그인'
          );
        }
        await page.close().catch(() => {});
      } catch (e) {
        console.log(C.warn(`  세션 검사 실패: ${e.message}`));
        console.log(C.dim('    (스케줄러가 같은 프로필을 쓰는 중이면 동시에 열 수 없습니다)'));
      } finally {
        try { await browserLib.browserClose('kmong'); } catch (_) {}
      }
    }
  }

  // ── 종합 ──────────────────────────────────────────────────
  hr('진단 결과');
  const errors = findings.filter((f) => f.level === 'error');
  const warns = findings.filter((f) => f.level === 'warn');

  if (!errors.length && !warns.length) {
    console.log(C.ok('  ✓ 파이프라인을 막는 문제를 찾지 못했습니다.'));
    console.log(C.dim('    자동지원이 여전히 안 된다면 logs/scheduler-*.log 의 최근 회차를 확인하세요.'));
  } else {
    let n = 0;
    for (const f of [...errors, ...warns]) {
      n++;
      const tag = f.level === 'error' ? C.bad('[치명]') : C.warn('[주의]');
      console.log(`  ${tag} ${n}. ${f.msg}`);
      console.log(`         ${C.dim('→ ' + f.fix)}`);
    }
  }

  console.log('');
  console.log(C.dim('  ※ 5번 필터 시뮬레이션은 이 스크립트에 복사된 키워드 규칙 기준입니다.'));
  console.log(C.dim('    kmong-scheduler.js 의 SKIP_KEYWORDS / INCLUDE_KEYWORDS 를 수정했다면'));
  console.log(C.dim('    이 파일 상단도 같이 맞춰야 진단이 정확합니다.'));
  console.log('');

  process.exit(errors.length ? 1 : 0);
})().catch((err) => {
  console.error(`\n진단기 오류: ${err.message}`);
  console.error(err.stack);
  process.exit(2);
});
