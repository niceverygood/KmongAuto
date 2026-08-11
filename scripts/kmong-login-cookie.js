#!/usr/bin/env node

/**
 * 크몽 세션 복구 — 쿠키 주입 방식 (비대화형).
 *
 * login-kmong.js 는 브라우저 창을 띄워 사람이 직접 로그인해야 하지만,
 * 이 스크립트는 이미 확보한 kmong_session 쿠키 값을 Playwright 프로필에
 * 주입하기만 하면 되므로 창을 띄우거나 손으로 로그인할 필요가 없다.
 *
 * "제안 실패: 로그인 세션 만료" (README 알려진 이슈 1번) 가 뜰 때 가장 빠른 복구 경로.
 * 세션 쿠키는 크몽 로그인 상태에서 브라우저 개발자도구(Application ▸ Cookies ▸
 * kmong.com) 의 kmong_session 값을 복사해 오면 된다.
 *
 * 쿠키 값 공급 방법 (우선순위 순):
 *   1) CLI 인자         : node scripts/kmong-login-cookie.js "<kmong_session 값>"
 *   2) 환경변수         : KMONG_SESSION="<값>" node scripts/kmong-login-cookie.js
 *   3) 로컬 파일(gitignored):
 *        config/kmong-cookies.local.json  또는  data/kmong-cookies.local.json
 *        형식 A) { "cookieString": "kmong_session=...; XSRF-TOKEN=...; x-kmong-auth=..." }
 *        형식 B) { "kmong_session": "...", "XSRF-TOKEN": "...", "x-kmong-auth": "..." }
 *
 * 개발자도구의 요청 헤더 Cookie 문자열을 통째로 복사해 형식 A 로 넣어도 되고,
 * kmong_session 하나만 넣어도 (다른 쿠키는 페이지 진입 시 서버가 재발급) 충분하다.
 *
 * ⚠️ kmong_session 은 로그인 세션 토큰(민감정보)이다. 절대 저장소에 커밋하지 말 것
 *    — 위 로컬 파일 경로들은 .gitignore 에 등록되어 있다.
 */

const fs = require('fs');
const path = require('path');
const { browserStart, browserClose } = require('../lib/browser');
const { WORKSPACE } = require('../lib/workspace');

const PROFILE = 'kmong';
const KMONG_URL = 'https://kmong.com';

// 세션에 실제로 필요한 쿠키만 화이트리스트로 주입 (그 외는 서버가 재발급)
const ALLOWED_COOKIES = new Set([
  'kmong_session',
  'XSRF-TOKEN',
  'x-kmong-auth',
  'remember_web',
]);

function parseCookieString(str) {
  const out = {};
  for (const part of String(str).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

// remember_web_* 처럼 접미사가 붙는 쿠키도 허용
function isAllowed(name) {
  if (ALLOWED_COOKIES.has(name)) return true;
  return [...ALLOWED_COOKIES].some(base => name.startsWith(base + '_') || name.startsWith(base));
}

function collectCookies() {
  // 1) CLI 인자
  const argValue = process.argv[2];
  if (argValue && argValue.trim()) {
    const trimmed = argValue.trim();
    // "name=value; ..." 형태면 통째로 파싱, 아니면 kmong_session 값으로 취급
    if (trimmed.includes('=') && trimmed.includes('kmong_session')) {
      return { source: 'CLI 인자(쿠키 문자열)', cookies: parseCookieString(trimmed) };
    }
    return { source: 'CLI 인자(kmong_session 값)', cookies: { kmong_session: trimmed } };
  }

  // 2) 환경변수
  if (process.env.KMONG_SESSION && process.env.KMONG_SESSION.trim()) {
    return { source: '환경변수 KMONG_SESSION', cookies: { kmong_session: process.env.KMONG_SESSION.trim() } };
  }
  if (process.env.KMONG_COOKIE_STRING && process.env.KMONG_COOKIE_STRING.trim()) {
    return { source: '환경변수 KMONG_COOKIE_STRING', cookies: parseCookieString(process.env.KMONG_COOKIE_STRING) };
  }

  // 3) 로컬 파일
  const candidates = [
    path.join(WORKSPACE, 'config/kmong-cookies.local.json'),
    path.join(WORKSPACE, 'data/kmong-cookies.local.json'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    let json;
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (e) {
      throw new Error(`쿠키 파일 파싱 실패 (${file}): ${e.message}`);
    }
    if (json.cookieString) {
      return { source: file, cookies: parseCookieString(json.cookieString) };
    }
    // 형식 B: 키=쿠키명
    const cookies = {};
    for (const [k, v] of Object.entries(json)) {
      if (typeof v === 'string') cookies[k] = v;
    }
    if (Object.keys(cookies).length) return { source: file, cookies };
  }

  return null;
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🍪 크몽 세션 복구 (쿠키 주입)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const found = collectCookies();
  if (!found) {
    console.error('❌ kmong_session 쿠키를 찾을 수 없습니다.\n');
    console.error('   다음 중 하나로 값을 공급하세요:');
    console.error('   1) node scripts/kmong-login-cookie.js "<kmong_session 값>"');
    console.error('   2) KMONG_SESSION="<값>" node scripts/kmong-login-cookie.js');
    console.error('   3) config/kmong-cookies.local.json 에');
    console.error('      { "cookieString": "kmong_session=...; XSRF-TOKEN=..." } 저장 후 실행\n');
    process.exit(1);
  }

  const { source, cookies } = found;
  const names = Object.keys(cookies).filter(isAllowed);
  if (!names.includes('kmong_session')) {
    console.error(`❌ (${source}) 에서 kmong_session 을 찾지 못했습니다. 주입 대상: ${names.join(', ') || '(없음)'}`);
    process.exit(1);
  }
  console.log(`📥 쿠키 소스: ${source}`);
  console.log(`   주입 대상: ${names.join(', ')}\n`);

  const toAdd = names.map(name => ({
    name,
    value: cookies[name],
    url: KMONG_URL, // domain/path/secure 는 URL 기준으로 Playwright 가 추론
  }));

  let context;
  try {
    console.log('[1/3] 🌐 브라우저 프로필 열기 + 쿠키 주입...');
    context = await browserStart(PROFILE, { headless: true });
    await context.addCookies(toAdd);
    console.log('✅\n');

    console.log('[2/3] 🔎 세션 검증 (users/me)...');
    const page = await context.newPage();
    await page.goto(KMONG_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
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

    if (me.status !== 200 || !me.json) {
      console.error(`❌ 세션 검증 실패 (users/me HTTP ${me.status}). 쿠키가 만료됐거나 값이 잘못됐습니다.`);
      console.error('   크몽에 다시 로그인한 상태에서 최신 kmong_session 값을 복사해 재시도하세요.');
      await page.close().catch(() => {});
      await browserClose(PROFILE);
      process.exit(1);
    }
    const username = me.json?.username || me.json?.user?.username || '(이름 확인 불가)';
    console.log(`✅ 로그인 확인: ${username}\n`);
    await page.close().catch(() => {});

    console.log('[3/3] 💾 세션 저장 (프로필 유지)...');
    await browserClose(PROFILE); // 컨텍스트 종료 시 쿠키가 프로필에 영구 저장됨
    console.log('✅\n');

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🎉 세션 복구 완료! 이제 scheduler / backfill / apply 가 자동 로그인됩니다.');
    console.log('   ⚠️ Phase 2(시제품 생성)까지 쓰려면 claude.ai 로그인은 별도로');
    console.log('      node scripts/login-kmong.js 로 한 번 세팅해야 합니다.');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    process.exit(0);
  } catch (err) {
    console.error(`\n❌ 오류: ${err.message}`);
    try { await browserClose(PROFILE); } catch (_) {}
    process.exit(1);
  }
}

main();
