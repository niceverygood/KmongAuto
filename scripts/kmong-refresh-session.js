#!/usr/bin/env node
/**
 * 크몽 로그인 세션 자동 갱신 — 매 회차 스케줄러 실행 직전에 호출된다.
 *
 * 액세스 토큰(x-kmong-authorization)은 유효기간이 1시간뿐이라, 손으로 붙여넣는
 * 방식으로는 시간당 1회 실행 중 사실상 첫 회차만 유효하다. 이 스크립트가 매 회차
 * 토큰을 스스로 재발급해서 컨테이너가 살아있는 한 세션이 끊기지 않게 한다.
 *
 * 갱신 경로 (위에서부터 시도, 먼저 성공하는 것을 쓴다):
 *   1. KMONG_REFRESH_TOKEN — kid.kmong.com 리프레시 엔드포인트로 새 액세스 토큰 발급.
 *      가볍고 빠르므로 가능하면 이 경로를 쓴다.
 *   2. KMONG_EMAIL + KMONG_PASSWORD — 헤드리스 브라우저로 직접 로그인해 쿠키 일습을
 *      새로 받는다. 리프레시 토큰마저 만료됐을 때의 최후 수단.
 *
 * 둘 다 설정되지 않았으면 아무것도 하지 않고 정상 종료한다(기존 쿠키로 진행).
 * 즉 환경변수를 넣기 전까지는 동작이 지금과 완전히 동일하다.
 *
 * Usage: node scripts/kmong-refresh-session.js
 * exit 0: 갱신 성공 또는 갱신 불필요 / 1: 갱신 시도했으나 실패
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../lib/workspace');

const COOKIE_FILE = path.join(DATA_DIR, 'kmong-cookies.local.json');
const REFRESH_URL = 'https://kid.kmong.com/api/authentication/v1/refresh';
const LOGIN_URL = 'https://kmong.com/users/login';

/** 액세스 토큰의 남은 수명(초). 토큰이 없거나 파싱 실패하면 0. */
function tokenRemainingSec(value) {
  try {
    const payload = JSON.parse(
      Buffer.from(decodeURIComponent(value).split('.')[1], 'base64url').toString()
    );
    return payload.exp - Math.floor(Date.now() / 1000);
  } catch (e) {
    return 0;
  }
}

function readCookies() {
  if (!fs.existsSync(COOKIE_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
  } catch (e) {
    return [];
  }
}

/** 같은 이름의 기존 쿠키를 밀어내고 새 값으로 갈아끼운다. */
function upsertCookie(cookies, name, value, expires) {
  const rest = cookies.filter(c => c.name !== name);
  rest.push({
    name,
    value,
    domain: '.kmong.com',
    path: '/',
    httpOnly: name === 'kmong_session',
    secure: true,
    sameSite: 'Lax',
    ...(expires ? { expires } : {}),
  });
  return rest;
}

function writeCookies(cookies) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
}

/** Set-Cookie 헤더 목록에서 이름 하나의 값을 뽑는다. */
function pickSetCookie(setCookies, name) {
  const hit = setCookies.find(s => s.startsWith(`${name}=`));
  if (!hit) return null;
  return hit.split(';')[0].slice(name.length + 1);
}

async function refreshViaToken(refreshToken, cookies) {
  const jar = cookies
    .filter(c => (c.domain || '').includes('kmong'))
    .map(c => `${c.name}=${c.value}`)
    .concat(`x-kmong-authorization-refreshment=${refreshToken}`)
    .join('; ');

  const res = await fetch(REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: jar },
    signal: AbortSignal.timeout(20000),
  });

  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const fresh = pickSetCookie(setCookies, 'x-kmong-authorization');

  if (!fresh) {
    // 401 본문에는 만료/무효화 사유가 담겨 있다. 토큰 값 자체는 절대 로그로 흘리지 않는다.
    let code = '';
    try {
      code = (JSON.parse(await res.text()).code) || '';
    } catch (e) {}
    console.log(`  [갱신] 리프레시 실패 (HTTP ${res.status}${code ? ` ${code}` : ''})`);
    return null;
  }

  const remaining = tokenRemainingSec(fresh);
  console.log(`  [갱신] 새 액세스 토큰 발급 — 유효 ${Math.round(remaining / 60)}분`);

  let next = upsertCookie(cookies, 'x-kmong-authorization', fresh, Math.floor(Date.now() / 1000) + remaining);
  const sess = pickSetCookie(setCookies, 'kmong_session');
  if (sess) next = upsertCookie(next, 'kmong_session', sess);
  return next;
}

async function refreshViaLogin(email, password) {
  const openclaw = require('../lib/openclaw-shim');
  const context = await openclaw.browserStart('openclaw', { headless: true });
  const page = await context.newPage();

  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.fill('input[type="email"], input[name="email"], #email', email);
    await page.fill('input[type="password"], input[name="password"], #password', password);
    await page.click('button[type="submit"]');
    await page.waitForURL(u => !/users\/login/.test(u.toString()), { timeout: 45000 });

    const harvested = (await context.cookies()).filter(c => (c.domain || '').includes('kmong'));
    const auth = harvested.find(c => c.name === 'x-kmong-authorization');
    if (!auth) {
      console.log('  [갱신] 로그인 후에도 액세스 토큰이 없음 — 캡차 또는 추가 인증 가능성');
      return null;
    }
    console.log(`  [갱신] 로그인 성공 — 쿠키 ${harvested.length}개 확보, 토큰 유효 ${Math.round(tokenRemainingSec(auth.value) / 60)}분`);
    return harvested;
  } finally {
    await page.close().catch(() => {});
    await openclaw.browserClose('openclaw').catch(() => {});
  }
}

(async () => {
  const refreshToken = process.env.KMONG_REFRESH_TOKEN || '';
  const email = process.env.KMONG_EMAIL || '';
  const password = process.env.KMONG_PASSWORD || '';

  if (!refreshToken && !(email && password)) {
    console.log('[세션갱신] KMONG_REFRESH_TOKEN / KMONG_EMAIL+KMONG_PASSWORD 미설정 — 기존 쿠키로 진행');
    process.exit(0);
  }

  const cookies = readCookies();
  const current = cookies.find(c => c.name === 'x-kmong-authorization');
  const remaining = current ? tokenRemainingSec(current.value) : 0;

  // 아직 10분 넘게 남았으면 굳이 건드리지 않는다 — 불필요한 재발급은 서버 쪽
  // 토큰 회전을 자극할 뿐 이득이 없다.
  if (remaining > 600) {
    console.log(`[세션갱신] 액세스 토큰 유효 ${Math.round(remaining / 60)}분 남음 — 갱신 생략`);
    process.exit(0);
  }

  console.log(`[세션갱신] 토큰 ${remaining > 0 ? `${Math.round(remaining / 60)}분 남음` : '만료됨'} — 갱신 시도`);

  let next = null;
  if (refreshToken) next = await refreshViaToken(refreshToken, cookies).catch(e => {
    console.log(`  [갱신] 리프레시 오류: ${e.message}`);
    return null;
  });

  if (!next && email && password) {
    next = await refreshViaLogin(email, password).catch(e => {
      console.log(`  [갱신] 로그인 오류: ${e.message.split('\n')[0]}`);
      return null;
    });
  }

  if (!next) {
    console.log('[세션갱신] ❌ 갱신 실패 — 기존 쿠키로 진행 (제출 단계에서 실패할 수 있음)');
    process.exit(1);
  }

  writeCookies(next);

  // 쿠키 파일만 갱신하면 Phase 3의 브라우저 프로필은 낡은 토큰을 그대로 쓴다.
  // 프로필에도 같이 반영해야 실제 제출이 새 세션으로 나간다.
  try {
    const openclaw = require('../lib/openclaw-shim');
    const context = await openclaw.browserStart('openclaw', { headless: true });
    await context.addCookies(next.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain || '.kmong.com',
      path: c.path || '/',
      httpOnly: !!c.httpOnly,
      secure: c.secure !== false,
      ...(c.expires ? { expires: c.expires } : {}),
    })));
    await openclaw.browserClose('openclaw').catch(() => {});
    console.log('[세션갱신] ✅ 쿠키 파일 + 브라우저 프로필 갱신 완료');
  } catch (e) {
    console.log(`[세션갱신] ⚠️ 프로필 반영 실패(쿠키 파일은 갱신됨): ${e.message.split('\n')[0]}`);
  }

  process.exit(0);
})().catch(err => {
  console.error(`[세션갱신] 예기치 못한 오류: ${err.message}`);
  process.exit(1);
});
