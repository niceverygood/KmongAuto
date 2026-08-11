/**
 * Playwright persistent context 래퍼 (위시켓 lib/openclaw-shim.js 이식).
 *
 * 프로필은 KmongAuto/.browser-profiles/<profile>/ 에 저장되어
 * 크몽 로그인 세션 / claude.ai 로그인 세션이 실행 간 유지된다.
 * 위시켓 자동화와 프로필을 분리해 두 스케줄러가 동시에 돌아도 충돌하지 않음.
 */

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { WORKSPACE } = require('./workspace');

const PROFILE_ROOT = path.join(WORKSPACE, '.browser-profiles');
if (!fs.existsSync(PROFILE_ROOT)) fs.mkdirSync(PROFILE_ROOT, { recursive: true });

const _contexts = new Map();

async function browserStart(profile = 'kmong', { headless = false } = {}) {
  if (_contexts.has(profile)) return _contexts.get(profile);
  const userDataDir = path.join(PROFILE_ROOT, profile);
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  _contexts.set(profile, context);
  return context;
}

async function browserClose(profile = 'kmong') {
  const context = _contexts.get(profile);
  if (context) {
    await context.close();
    _contexts.delete(profile);
  }
}

module.exports = { browserStart, browserClose };
