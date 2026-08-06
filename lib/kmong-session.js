/**
 * 크몽 로그인 세션 관리 — 만료 감지 / 자동 재로그인 / keep-alive.
 *
 * 문제:
 *   크몽 세션은 Playwright persistent profile(.browser-profiles/kmong) 안의
 *   쿠키(kmong_session, XSRF-TOKEN — Laravel)로만 유지된다.
 *   Laravel 세션은 "마지막 요청 이후" 기준으로 만료되는데, 스케줄러는 평일 3회만
 *   크몽에 접속하므로 금요일 17:00 → 월요일 10:30 사이 약 65시간이 무접속 구간이 된다.
 *   그 사이 세션이 죽으면 Phase 3가 "로그인 세션 없음/만료"로 중단되고,
 *   사람이 직접 login-kmong.js 를 재실행하기 전까지 제안이 무한 보류된다.
 *
 * 대응 (이 모듈이 제공하는 것):
 *   1) checkSession()  — 세션 유효성 확인 (users/me)
 *   2) ensureSession() — 만료 시 저장된 자격증명으로 자동 재로그인 후 재확인
 *   3) touchSession()  — keep-alive 용 ping (요청 자체가 Laravel 세션 수명을 갱신)
 *   4) shouldAlert()/markAlerted() — 슬랙 알림 스팸 방지용 쓰로틀
 *
 * 자격증명은 config/secrets.json 의 kmongEmail / kmongPassword 또는
 * 환경변수 KMONG_EMAIL / KMONG_PASSWORD 에서 읽는다. 없으면 자동 재로그인을
 * 건너뛰고 기존과 동일하게 "수동 로그인 필요"를 반환한다 (동작 후퇴 없음).
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = path.resolve(__dirname, '..');
const SECRETS_FILE = path.join(WORKSPACE, 'config/secrets.json');
const STATE_FILE = path.join(WORKSPACE, 'data/kmong-session-state.json');

const ORIGIN = 'https://kmong.com';
const HOME_URL = `${ORIGIN}/`;
const ME_API = '/api/msa/user-app/user/v1/users/me';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
// 자격증명 / 상태 파일
// ─────────────────────────────────────────────────────────────

function loadSecrets() {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function getCredentials() {
  const s = loadSecrets();
  return {
    email: process.env.KMONG_EMAIL || s.kmongEmail || '',
    password: process.env.KMONG_PASSWORD || s.kmongPassword || '',
  };
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveState(patch) {
  const next = { ...loadState(), ...patch };
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  } catch (e) {
    console.error(`[session] 상태 저장 실패: ${e.message}`);
  }
  return next;
}

/** 마지막 알림 이후 throttleHours 시간이 지났는지 (슬랙 스팸 방지). */
function shouldAlert(key = 'sessionExpired', throttleHours = 12) {
  const last = loadState()[`lastAlertAt_${key}`];
  if (!last) return true;
  const elapsedH = (Date.now() - new Date(last).getTime()) / 3600000;
  return !(elapsedH >= 0 && elapsedH < throttleHours);
}

function markAlerted(key = 'sessionExpired') {
  saveState({ [`lastAlertAt_${key}`]: new Date().toISOString() });
}

function clearAlert(key = 'sessionExpired') {
  const state = loadState();
  delete state[`lastAlertAt_${key}`];
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

// ─────────────────────────────────────────────────────────────
// in-page API 호출 (세션 쿠키 + XSRF 토큰 자동 포함)
// ─────────────────────────────────────────────────────────────

async function apiCall(page, method, apiPath, payload) {
  return page.evaluate(
    async ({ method, apiPath, payload }) => {
      const xsrfCookie = document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='));
      const token = xsrfCookie ? decodeURIComponent(xsrfCookie.split('=').slice(1).join('=')) : null;
      const headers = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
      if (payload !== undefined) headers['Content-Type'] = 'application/json';
      if (token) headers['X-XSRF-TOKEN'] = token;
      const res = await fetch(apiPath, {
        method,
        credentials: 'include',
        headers,
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (_) {}
      return { status: res.status, json, text: text.slice(0, 800) };
    },
    { method, apiPath, payload }
  );
}

/** users/me 는 kmong.com 오리진에서만 호출 가능 — 필요 시 이동. */
async function ensureOnKmong(page) {
  if (!page.url().startsWith(ORIGIN)) {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(1500);
  }
}

// ─────────────────────────────────────────────────────────────
// 세션 확인
// ─────────────────────────────────────────────────────────────

/**
 * 세션 유효성 확인.
 * 크몽 MSA API는 비로그인 시 401이 아니라 HTML 404 를 반환하므로
 * "200 + JSON" 이 아니면 전부 세션 문제로 간주한다.
 */
async function checkSession(page) {
  await ensureOnKmong(page);
  const me = await apiCall(page, 'GET', ME_API);
  const ok = me.status === 200 && !!me.json;
  const username = ok ? me.json?.username || me.json?.user?.username || '(이름 확인 불가)' : null;
  if (ok) saveState({ lastOkAt: new Date().toISOString(), lastUsername: username });
  return { ok, username, status: me.status };
}

// ─────────────────────────────────────────────────────────────
// 자동 재로그인
// ─────────────────────────────────────────────────────────────

const EMAIL_SELECTORS = [
  'input[name="email"]',
  'input[type="email"]',
  'input[name="username"]',
  'input[id*="email" i]',
  'input[placeholder*="이메일"]',
  'input[placeholder*="아이디"]',
];

const PASSWORD_SELECTORS = [
  'input[name="password"]',
  'input[type="password"]',
  'input[id*="password" i]',
  'input[placeholder*="비밀번호"]',
];

/** 후보 셀렉터 중 실제로 보이는 첫 요소를 반환 (없으면 null). */
async function firstVisible(page, selectors, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      try {
        if ((await loc.count()) > 0 && (await loc.isVisible())) return loc;
      } catch (_) {}
    }
    await sleep(300);
  }
  return null;
}

/**
 * 로그인 폼 열기.
 * 크몽 로그인은 별도 페이지가 아니라 모달이므로, 직접 URL → 실패 시 버튼 클릭 순으로 시도.
 */
async function openLoginForm(page) {
  // 1) 로그인 전용 URL 시도 (있으면 가장 안정적)
  for (const url of [`${ORIGIN}/login`, `${ORIGIN}/?login=true`]) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(2000);
      if (await firstVisible(page, PASSWORD_SELECTORS, 4000)) return true;
    } catch (_) {}
  }

  // 2) 메인에서 우상단 "로그인" 클릭 (모달)
  try {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
  } catch (_) {}

  const triggers = [
    page.getByRole('button', { name: /로그인/ }),
    page.getByRole('link', { name: /로그인/ }),
    page.locator('a[href*="login"]'),
    page.locator('text=로그인'),
  ];
  for (const trigger of triggers) {
    try {
      const el = trigger.first();
      if ((await el.count()) > 0 && (await el.isVisible())) {
        await el.click({ timeout: 5000 });
        await sleep(2000);
        if (await firstVisible(page, PASSWORD_SELECTORS, 5000)) return true;
      }
    } catch (_) {}
  }

  return !!(await firstVisible(page, PASSWORD_SELECTORS, 2000));
}

/** 로그인 실패 원인 추정 (캡차 / 비밀번호 오류 등). */
async function diagnoseLoginFailure(page) {
  try {
    const hasCaptcha = await page.evaluate(() => {
      const html = document.documentElement.innerHTML;
      return (
        /recaptcha|hcaptcha|captcha|자동입력\s*방지|보안문자/i.test(html) ||
        !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha')
      );
    });
    if (hasCaptcha) return 'CAPTCHA';

    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 3000) || '');
    if (/비밀번호가?\s*(일치하지|틀렸|올바르지)/.test(bodyText)) return 'BAD_CREDENTIALS';
    if (/존재하지\s*않는|가입되지\s*않은/.test(bodyText)) return 'BAD_CREDENTIALS';
    if (/인증|OTP|2단계|휴대폰/.test(bodyText)) return 'VERIFICATION_REQUIRED';
  } catch (_) {}
  return 'LOGIN_FAILED';
}

/**
 * 저장된 자격증명으로 로그인 시도.
 * @returns {{ok:boolean, reason?:string}}
 */
async function loginWithCredentials(page, { email, password }) {
  if (!email || !password) return { ok: false, reason: 'NO_CREDENTIALS' };

  if (!(await openLoginForm(page))) return { ok: false, reason: 'LOGIN_FORM_NOT_FOUND' };

  const emailInput = await firstVisible(page, EMAIL_SELECTORS, 8000);
  const passwordInput = await firstVisible(page, PASSWORD_SELECTORS, 8000);
  if (!emailInput || !passwordInput) return { ok: false, reason: 'LOGIN_FORM_NOT_FOUND' };

  try {
    await emailInput.click();
    await emailInput.fill(email);
    await sleep(300);
    await passwordInput.click();
    await passwordInput.fill(password);
    await sleep(300);
  } catch (e) {
    return { ok: false, reason: `FILL_FAILED: ${e.message}` };
  }

  // 제출: 전용 버튼 → 없으면 Enter
  let submitted = false;
  const submitCandidates = [
    page.locator('button[type="submit"]:visible'),
    page.getByRole('button', { name: /^로그인$/ }),
    page.getByRole('button', { name: /로그인/ }),
  ];
  for (const cand of submitCandidates) {
    try {
      const btn = cand.last();
      if ((await btn.count()) > 0 && (await btn.isVisible()) && (await btn.isEnabled())) {
        await btn.click({ timeout: 5000 });
        submitted = true;
        break;
      }
    } catch (_) {}
  }
  if (!submitted) {
    try {
      await passwordInput.press('Enter');
      submitted = true;
    } catch (_) {}
  }
  if (!submitted) return { ok: false, reason: 'SUBMIT_FAILED' };

  // 로그인 처리 대기 — users/me 가 통과할 때까지 폴링 (최대 30초)
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await sleep(2500);
    try {
      const me = await apiCall(page, 'GET', ME_API);
      if (me.status === 200 && me.json) return { ok: true };
    } catch (_) {
      // 페이지 이동 중이면 evaluate 가 실패할 수 있음 — 재시도
    }
  }

  return { ok: false, reason: await diagnoseLoginFailure(page) };
}

// ─────────────────────────────────────────────────────────────
// 공개 API
// ─────────────────────────────────────────────────────────────

const REASON_TEXT = {
  NO_CREDENTIALS:
    '자동 로그인 자격증명 없음 (config/secrets.json 의 kmongEmail/kmongPassword 또는 KMONG_EMAIL/KMONG_PASSWORD)',
  LOGIN_FORM_NOT_FOUND: '로그인 폼을 찾지 못함 (크몽 UI 변경 가능성)',
  BAD_CREDENTIALS: '이메일 또는 비밀번호 불일치',
  CAPTCHA: '캡차/보안문자 요구 — 자동 로그인 불가',
  VERIFICATION_REQUIRED: '추가 인증(2단계/휴대폰) 요구 — 자동 로그인 불가',
  SUBMIT_FAILED: '로그인 버튼 제출 실패',
  LOGIN_FAILED: '로그인 시도 후에도 세션이 생성되지 않음',
};

function describeReason(reason) {
  return REASON_TEXT[reason] || reason || '알 수 없는 오류';
}

/**
 * 세션 보장 — 유효하면 그대로, 만료면 자동 재로그인 후 재확인.
 *
 * @returns {{ok:boolean, username?:string, recovered:boolean, reason?:string, detail?:string}}
 *   ok=true  → 이후 API 호출 진행 가능
 *   ok=false → 사람이 개입해야 함 (reason/detail 을 슬랙 알림에 사용)
 */
async function ensureSession(page, { autoLogin = true, verbose = true } = {}) {
  const log = (m) => verbose && console.log(m);

  const first = await checkSession(page);
  if (first.ok) {
    log(`   로그인 확인: ${first.username}`);
    clearAlert(); // 복구되면 다음 만료 때 즉시 알림이 나가도록 쓰로틀 해제
    return { ok: true, username: first.username, recovered: false };
  }

  log(`   ⚠️ 세션 만료 감지 (users/me HTTP ${first.status})`);

  if (!autoLogin) {
    return { ok: false, recovered: false, reason: 'EXPIRED', detail: '자동 재로그인 비활성화' };
  }

  const creds = getCredentials();
  if (!creds.email || !creds.password) {
    log('   ↳ 자동 재로그인 건너뜀 (자격증명 미설정)');
    return {
      ok: false,
      recovered: false,
      reason: 'NO_CREDENTIALS',
      detail: describeReason('NO_CREDENTIALS'),
    };
  }

  log(`   ↻ 자동 재로그인 시도 (${creds.email})...`);
  const result = await loginWithCredentials(page, creds);

  if (!result.ok) {
    log(`   ❌ 자동 재로그인 실패: ${describeReason(result.reason)}`);
    return {
      ok: false,
      recovered: false,
      reason: result.reason,
      detail: describeReason(result.reason),
    };
  }

  const second = await checkSession(page);
  if (!second.ok) {
    return {
      ok: false,
      recovered: false,
      reason: 'LOGIN_FAILED',
      detail: describeReason('LOGIN_FAILED'),
    };
  }

  log(`   ✅ 자동 재로그인 성공: ${second.username}`);
  saveState({ lastLoginAt: new Date().toISOString() });
  clearAlert();
  return { ok: true, username: second.username, recovered: true };
}

/**
 * keep-alive ping — 요청 자체가 Laravel 세션의 마지막 활동 시각을 갱신한다.
 * 세션이 이미 죽었으면 ensureSession 이 자동 재로그인까지 시도한다.
 */
async function touchSession(page, opts = {}) {
  return ensureSession(page, opts);
}

module.exports = {
  checkSession,
  ensureSession,
  touchSession,
  loginWithCredentials,
  getCredentials,
  shouldAlert,
  markAlerted,
  clearAlert,
  describeReason,
  loadState,
  saveState,
  apiCall,
  ME_API,
  ORIGIN,
};
