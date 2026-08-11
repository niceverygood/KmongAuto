#!/usr/bin/env node
/**
 * 크몽 로그인 헬퍼 — 한 번만 실행해서 세션 저장.
 *
 * Usage: node scripts/login-kmong.js
 *
 * 브라우저 창이 뜨면:
 *   1) 크몽 탭에서 로그인 (전문가 계정)
 *   2) claude.ai 탭에서도 로그인 (Phase 2 시제품 생성에 필요)
 * 두 사이트 모두 로그인 확인 후 터미널에 Enter 누르면 종료.
 *
 * 같은 .browser-profiles/kmong 프로필을 다른 phase 들이 공유하므로
 * 이후 kmong-scheduler 실행 시 자동 로그인됩니다.
 */

const { browserStart, browserClose } = require('../lib/browser');

(async () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔐 크몽 로그인 헬퍼');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const context = await browserStart('kmong', { headless: false });

  // 크몽 로그인은 별도 페이지가 아니라 모달 — 메인 페이지에서 우상단 "로그인" 클릭
  const kmongPage = await context.newPage();
  await kmongPage.goto('https://kmong.com/', { waitUntil: 'domcontentloaded' });

  const claudePage = await context.newPage();
  await claudePage.goto('https://claude.ai/login', { waitUntil: 'domcontentloaded' }).catch(() => {});

  console.log('브라우저에서 직접 로그인하세요.');
  console.log('  탭 1: kmong.com — 우상단 "로그인" 버튼 클릭 → 전문가(판매자) 계정으로 로그인');
  console.log('  탭 2: claude.ai — Phase 2(시제품 생성)에 사용할 계정으로 로그인');
  console.log('');
  console.log('두 사이트 모두 로그인 완료 확인 → 터미널에 Enter');
  console.log('');

  await new Promise(resolve => {
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });

  console.log('\n세션 저장 중...');
  await browserClose('kmong');
  console.log('✅ 완료. 이제 kmong-scheduler 실행하면 자동 로그인됩니다.');
  process.exit(0);
})();
