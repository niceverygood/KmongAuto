/**
 * openclaw browser API shim using Playwright.
 *
 * wishket-automation의 lib/openclaw-shim.js를 크몽용으로 이식.
 * 로컬 세션 쿠키 파일 경로만 kmong 전용으로 변경.
 *
 * Persistent context per profile lives at WORKSPACE/.browser-profiles/<profile>/
 */

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { WORKSPACE } = require('./workspace');

const PROFILE_ROOT = path.join(WORKSPACE, '.browser-profiles');
if (!fs.existsSync(PROFILE_ROOT)) fs.mkdirSync(PROFILE_ROOT, { recursive: true });

const _contexts = new Map();
const _pagesByProfile = new Map();
let _nextTargetId = 1;

function _genTargetId() {
  return `page-${_nextTargetId++}`;
}

// Chromium 실행 파일 경로: CHROME_PATH env → playwright 기본 → 원격 컨테이너 프리인스톨 경로
function resolveChromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (_) {}
  const fallbacks = ['/opt/pw-browsers/chromium'];
  for (const p of fallbacks) {
    if (fs.existsSync(p)) return p;
  }
  return null; // playwright가 알아서 처리하도록
}

// 디스플레이 없는 환경(원격 컨테이너)에서는 headless 강제
function resolveHeadless(requested) {
  if (process.env.HEADLESS === '1' || process.env.HEADLESS === 'true') return true;
  if (process.env.HEADLESS === '0' || process.env.HEADLESS === 'false') return false;
  if (process.platform === 'linux' && !process.env.DISPLAY) return true;
  return requested;
}

async function browserStart(profile = 'openclaw', { headless = false } = {}) {
  if (_contexts.has(profile)) return _contexts.get(profile);
  const userDataDir = path.join(PROFILE_ROOT, profile);
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

  const launchOpts = {
    headless: resolveHeadless(headless),
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true, // 프록시 MITM CA 환경 대응
    args: ['--disable-blink-features=AutomationControlled'],
  };
  const executablePath = resolveChromePath();
  if (executablePath) launchOpts.executablePath = executablePath;
  if (process.platform === 'linux') {
    launchOpts.args.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage');
  }
  // 아웃바운드 프록시 환경(HTTPS_PROXY)이면 브라우저에도 명시 적용
  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxyServer) {
    launchOpts.proxy = { server: proxyServer };
    // 주의: bypass에 NO_PROXY를 넣지 않는다 — 이 컨테이너는 프록시 외 직접 egress가 없음
    // MITM 게이트웨이가 Chromium의 TLS1.3 ClientHello를 리셋하므로 TLS1.2로 강제 (검증됨)
    launchOpts.args.push('--ssl-version-max=tls1.2', '--disable-quic');
    // headless UA의 "HeadlessChrome"은 봇 차단 대상 — 일반 Chrome UA로 교체
    if (launchOpts.headless) {
      launchOpts.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
    }
  }

  const context = await chromium.launchPersistentContext(userDataDir, launchOpts);

  // 로컬 세션 쿠키 자동 로드 (gitignore 대상 파일) — 별도 import 실행 없이 모든 스크립트가 로그인 상태 공유
  try {
    const localCookieFile = path.join(WORKSPACE, 'data/kmong-cookies.local.json');
    if (fs.existsSync(localCookieFile)) {
      const raw = JSON.parse(fs.readFileSync(localCookieFile, 'utf-8'));
      const list = Array.isArray(raw) ? raw : (raw.cookies || []);
      const cookies = list.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        ...(typeof c.expires === 'number' && c.expires > 0 ? { expires: c.expires } : {}),
        ...(c.sameSite ? { sameSite: c.sameSite[0].toUpperCase() + c.sameSite.slice(1).toLowerCase() } : {}),
      })).filter(c => c.name && c.domain);
      if (cookies.length) await context.addCookies(cookies);
    }
  } catch (e) {
    console.error(`[shim] 로컬 쿠키 로드 실패 (무시): ${e.message}`);
  }

  _contexts.set(profile, context);
  _pagesByProfile.set(profile, new Map());
  return context;
}

async function _getPages(profile) {
  if (!_contexts.has(profile)) await browserStart(profile);
  return _pagesByProfile.get(profile);
}

async function browserOpen(profile = 'openclaw', url) {
  const context = await browserStart(profile);
  const pages = _pagesByProfile.get(profile);
  let page;
  if (context.pages().length && pages.size === 0) {
    page = context.pages()[0];
  } else {
    page = await context.newPage();
  }
  const targetId = _genTargetId();
  pages.set(targetId, page);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return { targetId };
}

function _resolvePage(profile, targetId) {
  const pages = _pagesByProfile.get(profile);
  if (!pages) throw new Error(`no profile started: ${profile}`);
  if (targetId && pages.has(targetId)) return pages.get(targetId);
  if (pages.size === 0) {
    const ctx = _contexts.get(profile);
    if (ctx && ctx.pages().length) return ctx.pages()[ctx.pages().length - 1];
    throw new Error(`no pages open in profile ${profile}`);
  }
  return [...pages.values()].pop();
}

async function browserSnapshot(profile = 'openclaw', targetId = null) {
  const page = _resolvePage(profile, targetId);
  const snapshot = await page.locator('body').ariaSnapshot({ timeout: 10000 }).catch(async () => {
    return await page.locator('html').ariaSnapshot({ timeout: 10000 });
  });
  return { snapshot };
}

async function browserAct(profile = 'openclaw', targetId, request) {
  const page = _resolvePage(profile, targetId);
  const req = typeof request === 'string' ? JSON.parse(request) : request;
  const { kind, selector, text } = req;
  switch (kind) {
    case 'click':
      await page.click(selector, { timeout: 15000 });
      return { ok: true };
    case 'type':
    case 'fill':
      await page.fill(selector, text ?? '', { timeout: 15000 });
      return { ok: true };
    case 'press':
      await page.press(selector, text, { timeout: 15000 });
      return { ok: true };
    default:
      throw new Error(`unsupported act kind: ${kind}`);
  }
}

async function browserClose(profile = 'openclaw') {
  const context = _contexts.get(profile);
  if (context) {
    await context.close();
    _contexts.delete(profile);
    _pagesByProfile.delete(profile);
  }
}

module.exports = {
  browserStart,
  browserOpen,
  browserSnapshot,
  browserAct,
  browserClose,
  resolveChromePath,
  resolveHeadless,
  PROFILE_ROOT,
};
