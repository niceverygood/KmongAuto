#!/usr/bin/env node
/**
 * 원격 환경 사전 점검 (preflight)
 *
 *   1. Chromium 실행 파일 (필수 — Phase 2/3 브라우저 자동화용)
 *   2. claude CLI (제안서·시제품 생성용, 필수)
 *   3. 네트워크: kmong.com 도달 가능 (필수 — 공개 API 스크래핑용)
 *   4. 네트워크: R2 (시제품 업로드, 필수)
 *   5. 크몽 로그인 세션 (Phase 3 실제 제출에만 필요 — dry-run 모드에서는 선택)
 *   6. 네트워크/로그인: claude.ai (선택 — 브라우저 시제품 생성용. 막혀도 claude CLI 폴백)
 *   7. Slack 웹훅 (선택 — 막히면 아웃박스로 대체)
 *
 * Usage:
 *   node scripts/check-setup.js
 *   node scripts/check-setup.js --network
 *
 * exit 0: 필수 항목 모두 OK / exit 2: 미충족 항목 있음
 */

const { execSync } = require('child_process');
const openclaw = require('../lib/openclaw-shim');

const NETWORK_ONLY = process.argv.includes('--network');
const DRY_RUN = process.env.SKIP_SUBMIT !== 'false';
const results = [];
let coreFailure = false;

function record(name, ok, detail, { optional = false } = {}) {
  results.push({ name, ok, detail, optional });
  if (!ok && !optional) coreFailure = true;
  const icon = ok ? '✅' : (optional ? '⚠️ ' : '❌');
  console.log(`${icon} ${name}: ${detail}`);
}

async function checkUrl(url, timeoutMs = 15000) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return { reachable: true, status: res.status };
  } catch (e) {
    return { reachable: false, error: e.cause?.message || e.message };
  }
}

(async () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔍 크몽 봇 사전 점검');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const chromePath = openclaw.resolveChromePath();
  record('Chromium', !!chromePath, chromePath || '실행 파일 못 찾음 (CHROME_PATH 설정 필요)');

  try {
    const v = execSync('claude --version', { encoding: 'utf-8', timeout: 30000 }).trim();
    record('claude CLI', true, v);
  } catch (e) {
    record('claude CLI', false, `실행 실패: ${e.message.split('\n')[0]}`);
  }

  const kmongNet = await checkUrl('https://kmong.com/api/custom-project/v1/requests?per_page=1');
  record('네트워크: kmong.com', kmongNet.reachable,
    kmongNet.reachable ? `HTTP ${kmongNet.status}` :
    `차단됨 (${kmongNet.error}) — Claude Code 환경 설정에서 네트워크 정책에 kmong.com 허용 필요`);

  const claudeNet = await checkUrl('https://claude.ai/');
  record('네트워크: claude.ai', claudeNet.reachable,
    claudeNet.reachable ? `HTTP ${claudeNet.status}` : `차단됨 (${claudeNet.error}) — claude CLI 폴백으로 시제품 생성`,
    { optional: true });

  const slackNet = await checkUrl('https://hooks.slack.com/');
  record('네트워크: hooks.slack.com', slackNet.reachable,
    slackNet.reachable ? `HTTP ${slackNet.status}` : `차단됨 — 아웃박스로 대체`, { optional: true });

  const r2Net = await checkUrl('https://e1ca9ed3f57c359ae0c7fca430f45281.r2.cloudflarestorage.com/');
  record('네트워크: R2 (시제품 업로드)', r2Net.reachable,
    r2Net.reachable ? `HTTP ${r2Net.status}` : `차단됨 (${r2Net.error})`);

  if (NETWORK_ONLY) {
    finish();
    return;
  }

  if (kmongNet.reachable || claudeNet.reachable) {
    try {
      const context = await openclaw.browserStart('openclaw', { headless: true });
      const page = await context.newPage();

      if (kmongNet.reachable) {
        try {
          await page.goto('https://kmong.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
          await new Promise(r => setTimeout(r, 2500));
          const linkText = await page.$$eval('a, button', els => els.map(e => e.textContent || '').join(' '));
          const loggedIn = /마이크몽|로그아웃/.test(linkText);
          const hasLoginLink = /로그인/.test(linkText) && /회원가입/.test(linkText);
          const ok = loggedIn || !hasLoginLink;
          record('크몽 로그인', ok,
            ok ? '세션 유효' : '비로그인 — import-session.js 로 세션 주입 필요 (Phase 3 실제 제출에만 필요)',
            { optional: DRY_RUN }); // dry-run 모드에서는 로그인 없어도 preflight 통과
        } catch (e) {
          record('크몽 로그인', false, `확인 실패: ${e.message.split('\n')[0]}`, { optional: DRY_RUN });
        }
      } else {
        record('크몽 로그인', false, '네트워크 차단으로 확인 불가', { optional: DRY_RUN });
      }

      if (claudeNet.reachable) {
        try {
          await page.goto('https://claude.ai/design', { waitUntil: 'domcontentloaded', timeout: 45000 });
          await new Promise(r => setTimeout(r, 6000));
          const url = page.url();
          const onLogin = /login|signup|auth/.test(url);
          record('claude.ai 로그인', !onLogin,
            onLogin ? `비로그인 (${url}) — claude CLI 폴백으로 시제품 생성` : `세션 유효 (${url})`,
            { optional: true });
        } catch (e) {
          record('claude.ai 로그인', false, `확인 실패: ${e.message.split('\n')[0]} — CLI 폴백`, { optional: true });
        }
      } else {
        record('claude.ai 로그인', false, '네트워크 차단 — CLI 폴백', { optional: true });
      }

      await page.close();
      await openclaw.browserClose('openclaw');
    } catch (e) {
      record('브라우저 기동', false, `실패: ${e.message.split('\n')[0]}`);
    }
  } else {
    record('크몽 로그인', false, '네트워크 차단으로 확인 불가', { optional: DRY_RUN });
    record('claude.ai 로그인', false, '네트워크 차단 — CLI 폴백', { optional: true });
  }

  finish();
})();

function finish() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (DRY_RUN) console.log('ℹ️  SKIP_SUBMIT=true (dry-run) — 크몽 로그인 미충족은 실패로 취급하지 않음');
  if (coreFailure) {
    const failed = results.filter(r => !r.ok && !r.optional).map(r => r.name);
    console.log(`❌ 미충족(필수): ${failed.join(', ')}`);
    console.log('PREFLIGHT: FAIL');
    process.exit(2);
  }
  console.log('✅ 모든 필수 항목 충족 — 봇 실행 가능');
  console.log('PREFLIGHT: OK');
  process.exit(0);
}
