#!/usr/bin/env node
/**
 * 로그인 세션 내보내기 — 기존에 봇이 돌던 컴퓨터(Mac)에서 실행.
 *
 * .browser-profiles/openclaw 프로필에서 kmong.com / claude.ai 쿠키를 뷱아
 * data/session-export.json 으로 저장한다.
 *
 * Usage (Mac에서):
 *   node scripts/export-session.js
 *   → data/session-export.json 생성
 *   → 이 파일을 원격 저장소에 커밋&푸시하거나 원격 환경에 복사한 뒤
 *     원격에서 `node scripts/import-session.js` 실행
 *
 * ⚠️ session-export.json 은 로그인 세션 그 자체다. private 저장소에서만 다들어야 한다.
 *    (kmong_session, x-kmong-authorization 등 인증 쿠키 포함 — 절대 채팅/이슈/PR 본문에 붙여넣지 말 것)
 */

const fs = require('fs');
const path = require('path');
const openclaw = require('../lib/openclaw-shim');
const { DATA_DIR } = require('../lib/workspace');

const EXPORT_DOMAINS = ['kmong.com', 'claude.ai', 'anthropic.com'];
const OUT_FILE = path.join(DATA_DIR, 'session-export.json');

(async () => {
  console.log('🔐 세션 내보내기 시작...');
  const context = await openclaw.browserStart('openclaw', { headless: true });

  const all = await context.cookies();
  const filtered = all.filter(c =>
    EXPORT_DOMAINS.some(d => (c.domain || '').includes(d))
  );

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({
    exportedAt: new Date().toISOString(),
    cookies: filtered,
  }, null, 2));

  const byDomain = {};
  for (const c of filtered) {
    const key = EXPORT_DOMAINS.find(d => (c.domain || '').includes(d)) || c.domain;
    byDomain[key] = (byDomain[key] || 0) + 1;
  }
  console.log(`✅ ${filtered.length}개 쿠키 저장: ${OUT_FILE}`);
  console.log('   도메인별:', JSON.stringify(byDomain));

  const hasKmongSession = filtered.some(c => c.name === 'kmong_session' && c.domain.includes('kmong'));
  const hasClaudeSession = filtered.some(c => c.domain.includes('claude.ai') && /session/i.test(c.name));
  console.log(`   크몽 로그인 세션(kmong_session): ${hasKmongSession ? '✅ 있음' : '❌ 없음 — 브라우저에서 크몽 로그인 후 다시 실행'}`);
  console.log(`   claude.ai 세션: ${hasClaudeSession ? '✅ 있음' : '⚠️ 세션성 쿠키 미확인 — claude.ai 로그인 상태 확인 필요'}`);

  await openclaw.browserClose('openclaw');
  process.exit(0);
})().catch(err => {
  console.error(`❌ 실패: ${err.message}`);
  process.exit(1);
});
