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
    // SPA라 domcontentloaded 시점엔 본문 API 응답이 아직 안 온 상태 — networkidle까지 기다려야
    // "제안하기" 버튼이 안정적으로 렌더링된다 (고정 sleep만으론 플레이키).
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await sleep(1500);
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
    // 제안 폼은 모달로 렌더링되며 domcontentloaded만으로는 아직 안 뜬 상태일 수 있다 —
    // networkidle까지 기다려야 안정적으로 textarea/input이 나타난다 (고정 sleep만으론 플레이키).
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await sleep(1500);
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

    console.log('[6/8] 💰 제안 금액/기간/세금계산서 입력...');
    // amount, days는 placeholder로만 의뢰 기본값이 표시될 뿐 실제 value는 비어있어
    // 채워주지 않으면 제출이 막힌다 — 의뢰에 표시된 기본값(placeholder) 그대로 제안한다.
    const amountInput = await page.$('input[name="amount"]');
    if (amountInput) {
      const placeholder = await amountInput.getAttribute('placeholder').catch(() => null);
      if (placeholder) {
        await reactSafeFill(amountInput, placeholder);
        console.log(`   제안 예산: ${placeholder}만원 입력`);
      }
    } else {
      console.log('   ⚠️ 예산 입력란(name="amount")을 찾지 못함');
    }

    const daysInput = await page.$('input[name="days"]');
    if (daysInput) {
      const placeholder = await daysInput.getAttribute('placeholder').catch(() => null);
      if (placeholder) {
        await reactSafeFill(daysInput, placeholder);
        console.log(`   제안 기간: ${placeholder}일 입력`);
      }
    } else {
      console.log('   ⚠️ 기간 입력란(name="days")을 찾지 못함');
    }

    // 세금계산서 발행 여부 — 의뢰 상세에 "세금계산서: 필요"로 명시된 경우가 많아 기본은 "가능" 선택.
    const taxInvoiceButtons = await page.$$('button');
    let clickedTaxButton = false;
    for (const btn of taxInvoiceButtons) {
      const text = await btn.evaluate(el => el.textContent.trim()).catch(() => '');
      if (text === '가능') {
        await btn.click().catch(() => {});
        clickedTaxButton = true;
        break;
      }
    }
    console.log(clickedTaxButton ? '   세금계산서 발행 여부: "가능" 선택' : '   ⚠️ 세금계산서 발행 여부 버튼을 찾지 못함');

    // 필수 동의 체크박스 (제안 금액 확인 / 수수료 확인)
    // 커스텀 스타일 체크박스라 숨겨진 input을 직접 click()해도 상태가 안 바뀔 수 있다 —
    // 클릭 후 input.checked를 실제로 검증하고, 안 됐으면 감싸는 label 클릭으로 재시도한다.
    // (첫 실제 제출 시도에서 이 미검증 클릭 때문에 필수 동의가 안 된 채 제출이 조용히
    //  거부됐고, 봇은 성공으로 오판했다.)
    async function ensureChecked(selector) {
      const setCheckedState = async () => page.evaluate(sel => {
        const el = document.querySelector(sel);
        return el ? el.checked : null;
      }, selector);

      let state = await setCheckedState();
      if (state === null) return false;
      if (state === true) return true;

      const el = await page.$(selector);
      await el.click().catch(() => {});
      await sleep(300);
      state = await setCheckedState();
      if (state === true) return true;

      // 숨겨진 input 클릭이 무시된 경우 — label을 통해 클릭
      await page.evaluate(sel => {
        const input = document.querySelector(sel);
        const label = input && input.closest('label');
        if (label) label.click();
      }, selector);
      await sleep(300);
      state = await setCheckedState();
      return state === true;
    }

    const billingOk = await ensureChecked('#checkBillingAmount');
    const commissionOk = await ensureChecked('#checkCommission');
    if (!billingOk || !commissionOk) {
      throw new Error(`필수 동의 체크 실패 (billing: ${billingOk}, commission: ${commissionOk}) — 제출 불가`);
    }
    console.log('   동의 체크박스: 2/2개 체크 확인됨 (checked=true 검증)');
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

    // 모달이 열려도 원래 페이지의 "제안하기" CTA 버튼이 DOM에 그대로 남아있고,
    // 모달 자체의 제출 버튼도 같은 텍스트("제안하기")를 쓴다. 모달은 나중에 DOM에
    // 추가되므로 동일 텍스트 버튼 중 마지막 것이 실제 제출 버튼이다.
    const proposalButtons = await page.$$('button:has-text("제안하기")');
    const submitButton = proposalButtons.length > 0 ? proposalButtons[proposalButtons.length - 1] : null;

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

    // 성공 검증 1: 제출이 수리되면 모달이 닫힌다 — textarea가 그대로면 검증 실패로
    // 폼이 열려있는 것 (첫 시도에서 URL만 보고 성공으로 오판한 전례가 있어 강화).
    const modalStillOpen = (await page.$$('textarea')).length > 0;
    if (modalStillOpen) {
      const bodyErr = await page.evaluate(() =>
        (document.body.innerText.match(/[^\n]*(?:필수|동의|입력|선택)[^\n]*해\s*주세요[^\n]*/g) || []).join(' | ')
      ).catch(() => '');
      throw new Error(`제출 후에도 제안 폼이 열려있음 — 실제 제출 실패${bodyErr ? ` (안내: ${bodyErr.slice(0, 200)})` : ''}`);
    }

    // 성공 검증 2: 페이지를 새로 열어 제안 접수 상태 확인 (이미 제안한 프로젝트는
    // 다시 제안할 수 없으므로 버튼/문구가 바뀐다). 문구를 못 찾아도 모달이 닫혔으면
    // 성공으로 간주하되 검증 결과를 로그로 남긴다.
    await page.goto(projectUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await sleep(1500);
    const proposedState = await page.evaluate(() => {
      const body = document.body.innerText;
      return /제안\s*완료|이미\s*제안|제안\s*수정|제안\s*내역/.test(body);
    }).catch(() => false);
    console.log(`   재방문 검증: ${proposedState ? '✅ 제안 접수 상태 확인' : '⚠️ 접수 문구 미확인 (모달 닫힘 기준 성공 처리)'}`);

    const finalUrl = page.url();
    console.log(`   ✅ 제출 후 URL: ${finalUrl}`);
    console.log('✅ 제안 제출 완료!\n');
    console.log(JSON.stringify({ success: true, finalUrl, verified: proposedState, screenshot: screenshotPath }));

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
