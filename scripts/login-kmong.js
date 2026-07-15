#!/usr/bin/env node
/**
 * 크몽 로그인 헬퍼 — 한 번만 실행해서 세션 저장.
 *
 * Usage: node scripts/login-kmong.js
 *
 * 브라우저 창이 뜨면 직접 로그인 후, 터미널에 Enter 누르면 종료.
 * 같은 .browser-profiles/openclaw 를 다른 phase 들이 공유하므로
 * 이후 kmong-scheduler / phase1 실행 시 자동 로그인됩니다.
 *
 * ⚠️ 화면 없는 원격 컨테이너에서는 실행할 수 없습니다 — 로컬 Mac 등에서 실행 후
 *    export-session.js → import-session.js 로 세션을 원격에 이전하세요.
 */

const openclaw = require('../lib/openclaw-shim');

(async () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔐 크몽 로그인 헬퍼');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const context = await openclaw.browserStart('openclaw', { headless: false });
  const page = await context.newPage();
  await page.goto('https://kmong.com/users/login', { waitUntil: 'domcontentloaded' });

  console.log('브라우저에서 직접 로그인하세요.');
  console.log('로그인 완료 → 메인 페이지(kmong.com) 까지 확인 → 터미널에 Enter');
  console.log('');

  await new Promise(resolve => {
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });

  console.log('\n세션 저장 중...');
  await page.close();
  await openclaw.browserClose('openclaw');
  console.log('✅ 완료. 이제 kmong-scheduler 실행하면 자동 로그인됩니다.');
  process.exit(0);
})();
