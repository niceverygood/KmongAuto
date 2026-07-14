#!/usr/bin/env node

/**
 * 크몽 프로젝트 의뢰 제안 자동 제출
 *
 * ⚠️ 셀렉터 검증 상태: 크몽 "제안하기" 폼은 로그인 후에만 접근 가능해 이 스크립트는
 * 로그인 세션 없이 실제 필드 셀렉터를 확인하지 못한 상태로 작성되었다.
 * 첫 실행은 반드시 SKIP_SUBMIT=true(기본값, dry-run)로 돌려서 폼 필드를 잘 찾는지
 * 스크린샷/로그로 확인한 뒤 SKIP_SUBMIT=false로 전환할 것.
 *
 * Usage: node automate-kmong-apply.js <projectUrl> <proposalContentFile> <prototypeUrl> [portfolioFile]
 *
 * 환경변수:
 *   SKIP_SUBMIT=true(기본)  최종 제출 버튼 클릭을 생략하고 폼 입력까지만 수행 (dry-run)
 *   SKIP_SUBMIT=false       실제 제출까지 수행
 */

const fs = require('fs');
const path = require('path');
const openclaw = require('../lib/openclaw-shim');

const COOKIE_FILE = fs.existsSync(path.join(__dirname, '../data/kmong-cookies.local.json'))
  ? path.join(__dirname, '../data/kmong-cookies.local.json')
  : path.join(__dirname, '../data/kmong-cookies.json');

const projectUrl = process.argv[2];
const proposalContentFile = process.argv[3];
const prototypeUrl = process.argv[4] || '';
const portfolioFile = process.argv[5] || '';

const DRY_RUN = process.env.SKIP_SUBMIT !== 'false'; // 기본값: dry-run (사용자 승인된 초기 배포 정책)

if (!projectUrl || !proposalContentFile) {
  console.error('Usage: node automate-kmong-apply.js <projectUrl> <proposalContentFile> <prototypeUrl> [portfolioFile]');
  process.exit(1);
}

let APPLICATION_TEMPLATE = '';
if (fs.existsSync(proposalContentFile)) {
  APPLICATION_TEMPLATE = fs.readFileSync(proposalContentFile, 'utf-8');
  if (prototypeUrl && (APPLICATION_TEMPLATE.includes('{{PROTOTYPE_URL}}'))) {
    APPLICATION_TEMPLATE = APPLICATION_TEMPLATE.replace(/\{\{PROTOTYPE_URL\}\}/g, prototypeUrl);
    fs.writeFileSync(proposalContentFile, APPLICATION_TEMPLATE);
    console.log(`[제안 내용] 시제품 URL 자동 삽입 완료: ${prototypeUrl}`);
  }
  console.log(`[제안 내용] ${APPLICATION_TEMPLATE.length}자 로드 완료`);
} else {
  console.error(`제안 내용 파일을 찾을 수 없습니다: ${proposalContentFile}`);
  process.exit(1);
}

let portfolioDescription = '';
if (portfolioFile && fs.existsSync(portfolioFile)) {
  portfolioDescription = fs.readFileSync(portfolioFile, 'utf-8').trim().slice(0, 2000);
  console.log(`[포트폴리오] ${portfolioDescription.length}자 로드 완료`);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// React 컨트롤드 컴포넌트에 안전하게 값 주입 (wishket-automation의 reactSafeFill과 동일 기법)
async function reactSafeFill(handle, text) {
  await handle.click();
  await sleep(150);
  await handle.evaluate((el, t) => {
    el.focus();
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(el, t);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, text);
  await handle.press('End');
  await sleep(50);
  await handle.press(' ');
  await sleep(50);
  await handle.press('Backspace');
  await sleep(100);
  await handle.evaluate(el => el.dispatchEvent(new Event('blur', { bubbles: true })));
}

async function findByText(page, selectors, textPattern) {
  for (const selector of selectors) {
    try {
      const el = await page.$(selector);
      if (el) return el;
    } catch (_) {}
  }
  const candidates = await page.$$('button, a');
  for (const el of candidates) {
    const text = await page.evaluate(node => node.textContent, el).catch(() => '');
    if (text && textPattern.test(text)) return el;
  }
  return null;
}

(async () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📝 크몽 제안 자동 제출 ${DRY_RUN ? '(DRY-RUN — 실제 제출 생략)' : '(실제 제출)'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  let context;
  let page;

  try {
    console.log('[1/8] 🌐 브라우저 시작...');
    context = await openclaw.browserStart('openclaw', { headless: false });
    console.log('✅\n');

    console.log('[2/8] 📄 프로젝트 페이지 열기...');
    console.log(`   ${projectUrl}`);
    page = await context.newPage();

    if (fs.existsSync(COOKIE_FILE)) {
      try {
        const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
        const normalized = cookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          expires: typeof c.expires === 'number' ? c.expires : undefined,
          httpOnly: !!c.httpOnly,
          secure: !!c.secure,
          sameSite: c.sameSite ? (c.sameSite[0].toUpperCase() + c.sameSite.slice(1).toLowerCase()) : undefined,
        })).filter(c => c.name && c.domain);
        await context.addCookies(normalized);
        console.log(`   쿠키 로드 완료 (${normalized.length}개)`);
      } catch (e) {
        console.log(`   쿠키 로드 실패 (무시): ${e.message}`);
      }
    }

    await page.goto(projectUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    console.log('✅\n');

    // 로그인 상태 확인 — "로그인 후 제안하기" 문구가 보이면 세션 미인증
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (/로그인\s*후\s*제안하기/.test(bodyText)) {
      throw new Error('로그인 세션 없음 — data/kmong-cookies.local.json 또는 import-session.js로 세션 주입 필요');
    }

    console.log('[3/8] 🔍 제안하기 버튼 찾기...');
    const applyButton = await findByText(page, [
      'button:has-text("제안하기")',
      'a:has-text("제안하기")',
      'button[class*="proposal"]',
      'a[class*="proposal"]',
    ], /제안하기/);

    if (!applyButton) throw new Error('제안하기 버튼을 찾을 수 없습니다');
    console.log('✅\n');

    console.log('[4/8] 🖱️  제안하기 버튼 클릭...');
    await applyButton.click();
    await sleep(3000);
    console.log(`   현재 URL: ${page.url()}`);
    console.log('✅\n');

    console.log('[5/8] ✍️  제안 내용 입력...');
    const allTextareas = await page.$$('textarea');
    console.log(`   총 ${allTextareas.length}개 textarea 발견`);

    if (allTextareas.length === 0) {
      throw new Error('제안 내용 입력란(textarea)을 찾을 수 없습니다 — 폼 구조 확인 필요');
    }

    // 가장 긴 placeholder/가장 큰 textarea를 본문으로 추정 (셀렉터 미검증 — 첫 dry-run에서 스크린샷으로 확인 권장)
    let contentTextarea = allTextareas[0];
    let maxArea = 0;
    for (const ta of allTextareas) {
      const box = await ta.boundingBox().catch(() => null);
      const area = box ? box.width * box.height : 0;
      if (area > maxArea) { maxArea = area; contentTextarea = ta; }
    }

    await reactSafeFill(contentTextarea, APPLICATION_TEMPLATE);
    console.log(`   ${APPLICATION_TEMPLATE.length}자 입력 완료`);
    console.log('✅\n');

    console.log('[6/8] 💰 예상 금액/기간 필드 확인...');
    const numberInputs = await page.$$('input[type="number"], input[name*="amount"], input[name*="price"], input[name*="budget"]');
    console.log(`   숫자/금액 관련 input ${numberInputs.length}개 발견 (자동 입력은 생략 — 플랫폼 기본값/의뢰 조건 그대로 유지)`);
    console.log('✅\n');

    console.log('[7/8] 📁 포트폴리오 설명 입력 시도...');
    if (portfolioDescription) {
      const portfolioTextarea = allTextareas.find(ta => ta !== contentTextarea) || null;
      if (portfolioTextarea) {
        try {
          await reactSafeFill(portfolioTextarea, portfolioDescription);
          console.log(`   포트폴리오 설명 입력: ${portfolioDescription.length}자`);
        } catch (e) {
          console.log(`   ⚠️ 포트폴리오 입력 실패: ${e.message}`);
        }
      } else {
        console.log('   ⚠️ 포트폴리오 입력란을 찾지 못함');
      }
    } else {
      console.log('   포트폴리오 설명 없음 — 생략');
    }
    console.log('✅\n');

    // 스크린샷은 항상 남긴다 (dry-run이든 실제든 폼 상태 확인용)
    const tempDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const screenshotPath = path.join(tempDir, `kmong-apply-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    console.log(`   📸 폼 상태 스크린샷: ${screenshotPath}`);

    console.log('[8/8] 🚀 제출...');
    if (DRY_RUN) {
      console.log('   DRY-RUN 모드 — 실제 제출 버튼 클릭 생략');
      console.log('   SKIP_SUBMIT=false 로 재실행하면 실제 제출됩니다 (셀렉터 검증 후 권장)');
      console.log(JSON.stringify({ success: false, dryRun: true, screenshot: screenshotPath }));
      if (context) await openclaw.browserClose('openclaw');
      process.exit(0);
    }

    const submitButton = await findByText(page, [
      'button:has-text("제안서 제출")',
      'button:has-text("제안하기")',
      'button[type="submit"]',
    ], /제출|등록/);

    if (!submitButton) {
      throw new Error('제출 버튼을 찾을 수 없습니다 (셀렉터 확인 필요)');
    }

    await submitButton.evaluate(el => el.scrollIntoView({ block: 'center' }));
    await sleep(1000);
    await submitButton.evaluate(el => el.click());
    await sleep(3000);

    const confirmButton = await page.$('button:has-text("확인"), button:has-text("제출")').catch(() => null);
    if (confirmButton) {
      await confirmButton.click().catch(() => {});
      await sleep(3000);
    }

    const finalUrl = page.url();
    const stillOnApplyForm = /제안하기|proposal/i.test(finalUrl) && finalUrl === projectUrl;
    if (stillOnApplyForm) {
      throw new Error(`제출 후에도 URL 변화 없음 — 실제 제출 실패 가능성: ${finalUrl}`);
    }

    console.log(`   ✅ 제출 후 URL: ${finalUrl}`);
    console.log('✅ 제안 제출 완료!\n');
    console.log(JSON.stringify({ success: true, finalUrl, screenshot: screenshotPath }));

    if (typeof page !== 'undefined' && page) {
      try { await page.close(); } catch (e) {}
    }
    if (context) {
      try { await openclaw.browserClose('openclaw'); } catch (e) {}
    }
    process.exit(0);

  } catch (error) {
    console.error(`\n❌ 오류: ${error.message}\n`);
    console.error(error.stack);
    if (page) {
      try {
        const tempDir = path.join(__dirname, '../temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const errShot = path.join(tempDir, `kmong-apply-error-${Date.now()}.png`);
        await page.screenshot({ path: errShot, fullPage: true });
        console.error(`   스크린샷: ${errShot}`);
      } catch (_) {}
    }
    console.log(JSON.stringify({ success: false, error: error.message }));
    process.exitCode = 1;
  } finally {
    if (context) {
      try { await openclaw.browserClose('openclaw'); } catch (e) {}
    }
  }
})();
