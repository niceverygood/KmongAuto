#!/usr/bin/env node
/**
 * 로그인 세션 가져오기 — 원격(리눅스 컨테이너)에서 실행.
 *
 * data/session-export.json (export-session.js 산출물) 또는 인자로 준 쿠키 JSON을
 * .browser-profiles/openclaw 영구 프로필에 주입한다.
 *
 * 지원 입력 형식:
 *   1. export-session.js 산출물: { cookies: [...] }
 *   2. playwright storageState: { cookies: [...], origins: [...] }
 *   3. 쿠키 배열 그대로: [...]
 *
 * Usage:
 *   node scripts/import-session.js [cookie-json-path]   (기본: data/session-export.json)
 */

const fs = require('fs');
const path = require('path');
const openclaw = require('../lib/openclaw-shim');
const { DATA_DIR } = require('../lib/workspace');

const inputPath = process.argv[2] || path.join(DATA_DIR, 'session-export.json');

if (!fs.existsSync(inputPath)) {
  console.error(`❌ 입력 파일 없음: ${inputPath}`);
  console.error('   로그인된 브라우저에서 `node scripts/export-session.js` 실행 후 data/session-export.json 을 이 저장소로 가져오세요.');
  process.exit(1);
}

function normalizeSameSite(v) {
  if (!v) return undefined;
  const s = String(v).toLowerCase();
  if (s === 'no_restriction' || s === 'none') return 'None';
  if (s === 'lax') return 'Lax';
  if (s === 'strict') return 'Strict';
  return undefined;
}

function normalizeCookie(c) {
  const expires = typeof c.expires === 'number' ? c.expires
    : typeof c.expirationDate === 'number' ? Math.floor(c.expirationDate)
    : undefined;
  const cookie = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
  };
  if (expires && expires > 0) cookie.expires = expires;
  const ss = normalizeSameSite(c.sameSite);
  if (ss) cookie.sameSite = ss;
  return cookie;
}

(async () => {
  console.log(`🔐 세션 가져오기: ${inputPath}`);
  const raw = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  const list = Array.isArray(raw) ? raw : (raw.cookies || []);
  if (!list.length) {
    console.error('❌ 쿠키가 비어 있습니다.');
    process.exit(1);
  }

  const cookies = list.map(normalizeCookie).filter(c => c.name && c.domain);

  const context = await openclaw.browserStart('openclaw', { headless: true });
  await context.addCookies(cookies);
  console.log(`✅ ${cookies.length}개 쿠키를 브라우저 프로필에 주입`);

  const kmongCookies = cookies.filter(c => (c.domain || '').includes('kmong'));
  if (kmongCookies.length) {
    const backupPath = path.join(DATA_DIR, 'kmong-cookies.local.json');
    fs.writeFileSync(backupPath, JSON.stringify(kmongCookies, null, 2));
    console.log(`✅ 크몽 쿠키 ${kmongCookies.length}개 → ${backupPath}`);
  }

  console.log('\n🔎 로그인 상태 검증...');
  const page = await context.newPage();

  try {
    await page.goto('https://kmong.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    const anchorText = (await page.$$eval('a', as => as.map(a => a.textContent).join(' '))).slice(0, 2000);
    const loggedIn = /마이크몽|로그아웃/.test(anchorText) || !/로그인|회원가입/.test(anchorText);
    console.log(`   크몽: ${loggedIn ? '✅ 로그인됨' : '❌ 비로그인 (세션 만료 또는 쿠키 누락)'}`);
  } catch (e) {
    console.log(`   크몽: ⚠️ 확인 실패 (${e.message.split('\n')[0]})`);
  }

  try {
    await page.goto('https://claude.ai/design', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise(r => setTimeout(r, 5000));
    const url = page.url();
    const onLogin = /login|signup|auth/.test(url);
    console.log(`   claude.ai: ${onLogin ? '❌ 비로그인 (' + url + ')' : '✅ 로그인됨 (' + url + ')'}`);
  } catch (e) {
    console.log(`   claude.ai: ⚠️ 확인 실패 (${e.message.split('\n')[0]})`);
  }

  await page.close();
  await openclaw.browserClose('openclaw');
  console.log('\n완료. `node scripts/check-setup.js` 로 전체 상태를 다시 확인하세요.');
  process.exit(0);
})().catch(err => {
  console.error(`❌ 실패: ${err.message}`);
  process.exit(1);
});
