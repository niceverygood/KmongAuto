#!/usr/bin/env node
/**
 * Cloudflare R2 API 토큰 자동 발급 — 로컬 PC에서 실행 (Codex 등이 대신 돌려도 된다).
 *
 * Cloudflare 대시보드를 브라우저로 몰아 R2 API 토큰을 새로 만들고, 발급 직후 한 번만 노출되는
 * Access Key ID / Secret Access Key 를 긁어서 gitignore 대상 파일에 저장한다.
 *
 * 왜 자동화가 필요한가: R2 시크릿은 생성 화면을 벗어나면 다시 볼 수 없어 매번 사람이 붙잡고
 * 있어야 했다. 로그인만 사람이 하고 나머지는 스크립트가 처리한다.
 *
 * ⚠️ 원격 컨테이너에서는 실행할 수 없다(로그인·2FA에 사람이 필요). 반드시 로컬 PC에서 실행할 것.
 * ⚠️ 발급된 키는 절대 채팅·커밋·스크린샷으로 옮기지 말고, 저장된 파일에서 직접 복사해
 *    Claude Code 웹 환경변수(R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY)에 입력한다.
 *
 * Usage:
 *   npm i playwright && npx playwright install chromium   # 최초 1회
 *   node scripts/fetch-r2-credentials.js
 *
 * 환경변수(선택):
 *   R2_ACCOUNT_ID   Cloudflare 계정 ID (기본: 이 저장소가 쓰는 계정)
 *   R2_TOKEN_NAME   생성할 토큰 이름 (기본: kmong-auto-<날짜>)
 *   R2_OUT_FILE     저장 경로 (기본: data/r2-credentials.local.txt)
 *   HEADLESS=1      브라우저 창을 숨김 — 로그인 세션이 이미 프로필에 있을 때만 쓸 것
 *
 * exit 0: 발급·저장 성공 / 1: 실패
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID || 'e1ca9ed3f57c359ae0c7fca430f45281';
const TOKEN_NAME = process.env.R2_TOKEN_NAME || `kmong-auto-${new Date().toISOString().slice(0, 10)}`;
const OUT_FILE = process.env.R2_OUT_FILE || path.join(__dirname, '..', 'data', 'r2-credentials.local.txt');
const PROFILE_DIR = path.join(__dirname, '..', '.browser-profiles', 'cloudflare');
const TOKENS_URL = `https://dash.cloudflare.com/${ACCOUNT_ID}/r2/api-tokens`;

// 발급 화면의 키 형식 — Access Key ID는 32자, Secret은 64자 hex다.
// 대시보드 DOM 구조는 자주 바뀌므로 라벨 대신 이 형태로 본문에서 직접 건져낸다.
const ACCESS_KEY_RE = /\b[0-9a-f]{32}\b/g;
const SECRET_KEY_RE = /\b[0-9a-f]{64}\b/g;

function waitForEnter(message) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => { rl.close(); resolve(); });
  });
}

/** 화면에 보이는 첫 번째 후보를 클릭한다. 문구가 조금씩 바뀌어도 견디도록 여러 후보를 받는다. */
async function clickFirst(page, candidates, { timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const c of candidates) {
      const loc = typeof c === 'string' ? page.getByRole('button', { name: c }) : c(page);
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        if (await el.isVisible().catch(() => false)) {
          await el.click().catch(() => {});
          return true;
        }
      }
    }
    await page.waitForTimeout(500);
  }
  return false;
}

(async () => {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    console.error('❌ playwright가 없습니다. `npm i playwright && npx playwright install chromium` 후 다시 실행하세요.');
    process.exit(1);
  }

  const headless = process.env.HEADLESS === '1';
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔑 Cloudflare R2 API 토큰 발급');
  console.log(`   계정: ${ACCOUNT_ID}`);
  console.log(`   토큰 이름: ${TOKEN_NAME}`);
  console.log(`   저장 위치: ${OUT_FILE}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless,
      viewport: { width: 1440, height: 960 },
    });
  } catch (e) {
    // 브라우저 바이너리가 없거나(설치 누락) 화면 없는 환경에서 창을 띄우려 한 경우.
    console.error(`❌ 브라우저를 실행할 수 없습니다: ${e.message.split('\n')[0]}`);
    console.error('   `npx playwright install chromium` 을 실행했는지, 화면이 있는 로컬 PC인지 확인하세요.');
    process.exit(1);
  }
  const page = context.pages()[0] || await context.newPage();

  try {
    await page.goto(TOKENS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    // 로그인 화면으로 튕겼으면 사람이 직접 로그인한다(2FA 때문에 자동화 불가).
    if (/\/login|\/sign-?in/.test(page.url())) {
      if (headless) {
        console.error('❌ 로그인이 필요한데 HEADLESS=1 입니다. HEADLESS 없이 다시 실행해 직접 로그인하세요.');
        process.exit(1);
      }
      console.log('🔐 Cloudflare 로그인이 필요합니다. 열린 브라우저에서 로그인(2FA 포함)을 마쳐주세요.');
      await waitForEnter('   로그인 완료 후 이 터미널에서 Enter를 누르세요... ');
      await page.goto(TOKENS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);
    }

    console.log('▶ 토큰 생성 화면으로 이동...');
    const opened = await clickFirst(page, [
      /API 토큰 만들기/i, /계정 API 토큰 만들기/i,
      /Create API token/i, /Create Account API token/i, /Create User API token/i,
      p => p.getByRole('link', { name: /API token/i }),
    ], { timeout: 20000 });
    if (!opened) {
      console.error('❌ "API 토큰 만들기" 버튼을 찾지 못했습니다. 대시보드 UI가 바뀌었을 수 있습니다.');
      console.error(`   현재 URL: ${page.url()}`);
      console.error('   브라우저에서 직접 토큰을 만든 뒤, 키 두 개를 아래 파일에 수동으로 적어도 됩니다:');
      console.error(`   ${OUT_FILE}`);
      if (!headless) await waitForEnter('   확인했으면 Enter... ');
      process.exit(1);
    }
    await page.waitForTimeout(3000);

    // 토큰 이름 입력 — 이름 필드는 보통 화면의 첫 번째 텍스트 입력이다.
    const nameField = page.locator('input[type="text"]:visible').first();
    if (await nameField.count()) {
      await nameField.fill(TOKEN_NAME).catch(() => {});
      console.log(`▶ 토큰 이름 입력: ${TOKEN_NAME}`);
    }

    // 권한: 시제품 업로드에는 읽기+쓰기가 필요하다.
    await clickFirst(page, [
      p => p.getByText(/Object Read & Write|개체 읽기 및 쓰기|읽기 및 쓰기/i),
      p => p.getByRole('radio', { name: /Read.*Write|읽기.*쓰기/i }),
    ], { timeout: 5000 });

    console.log('▶ 토큰 생성 요청...');
    await clickFirst(page, [
      /^API 토큰 만들기$/i, /^토큰 만들기$/i, /^만들기$/i,
      /^Create API Token$/i, /^Create Token$/i, /^Create$/i,
    ], { timeout: 20000 });

    // 생성 결과 화면에 키가 뜰 때까지 기다린다.
    console.log('▶ 발급된 키 확인 중...');
    let accessKeyId = '';
    let secretAccessKey = '';
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const body = await page.evaluate(() => document.body.innerText).catch(() => '');
      const secrets = body.match(SECRET_KEY_RE) || [];
      // 64자 hex는 32자 hex 정규식에도 걸리므로, 시크릿에 포함되지 않은 32자만 액세스 키로 본다.
      const accesses = (body.match(ACCESS_KEY_RE) || []).filter(a => !secrets.some(s => s.includes(a)));
      if (secrets.length && accesses.length) {
        secretAccessKey = secrets[0];
        accessKeyId = accesses[0];
        break;
      }
      await page.waitForTimeout(1000);
    }

    if (!accessKeyId || !secretAccessKey) {
      console.error('❌ 발급된 키를 화면에서 찾지 못했습니다.');
      console.error('   브라우저 화면에 키가 보이면 직접 복사해 아래 파일에 저장하세요:');
      console.error(`   ${OUT_FILE}`);
      if (!headless) await waitForEnter('   확인했으면 Enter... ');
      process.exit(1);
    }

    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, [
      `# Cloudflare R2 API 토큰 (${TOKEN_NAME})`,
      `# 발급: ${new Date().toISOString()}`,
      `# 이 파일은 gitignore 대상입니다. 값을 채팅/커밋/스크린샷으로 옮기지 마세요.`,
      `# Claude Code 웹 환경변수에 아래 두 값을 그대로 입력하면 됩니다.`,
      ``,
      `R2_ACCESS_KEY_ID=${accessKeyId}`,
      `R2_SECRET_ACCESS_KEY=${secretAccessKey}`,
      ``,
    ].join('\n'), { mode: 0o600 });

    // 값 자체는 로그로 흘리지 않는다 — 길이와 앞 4자만 찍어 저장이 맞는지 확인시킨다.
    console.log('\n✅ 발급·저장 완료');
    console.log(`   R2_ACCESS_KEY_ID     : ${accessKeyId.slice(0, 4)}… (${accessKeyId.length}자)`);
    console.log(`   R2_SECRET_ACCESS_KEY : ${secretAccessKey.slice(0, 4)}… (${secretAccessKey.length}자)`);
    console.log(`   저장 파일: ${OUT_FILE}`);
    console.log('\n다음 단계: 이 파일을 열어 두 값을 Claude Code 웹 환경변수에 입력하세요.');
    process.exit(0);

  } catch (err) {
    console.error(`❌ 실패: ${err.message.split('\n')[0]}`);
    if (!headless) {
      console.error('   브라우저를 열어둡니다. 직접 토큰을 만들어 파일에 적어도 됩니다.');
      await waitForEnter('   Enter를 누르면 종료합니다... ');
    }
    process.exit(1);
  } finally {
    await context.close().catch(() => {});
  }
})();
