#!/usr/bin/env node
/**
 * claude.ai/design 자동화 → HTML 다운로드 → R2 업로드 → public URL 반환
 *
 * wishket-automation과 동일 — claude.ai/design 자동화는 플랫폼 무관 범용 로직이라 그대로 이식.
 *
 * Usage: node scripts/automate-claude-design.js <prompt-file>
 *
 * Output (stdout 마지막 줄): {"success":true,"url":"https://file.bottlecorp.kr/designs/...html"}
 */

const fs = require('fs');
const path = require('path');
const openclaw = require('../lib/openclaw-shim');

const promptPath = process.argv[2];
if (!promptPath || !fs.existsSync(promptPath)) {
  console.error('Usage: node automate-claude-design.js <prompt-file>');
  process.exit(1);
}

const { uploadToR2 } = require('../lib/r2');

const prompt = fs.readFileSync(promptPath, 'utf-8').trim();
const tempDir = path.dirname(promptPath);

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🎨 claude.ai/design 자동화');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  let context, page;
  let downloadedPath = null;

  try {
    console.log('[1/9] 🌐 브라우저 시작...');
    context = await openclaw.browserStart('openclaw', { headless: false });

    const attachDownloadListener = (p, label) => {
      p.on('download', async (download) => {
        const fname = download.suggestedFilename();
        console.log(`   📥 [${label}] download event: ${fname}`);
        if (downloadedPath) {
          console.log(`   📥 [${label}] 이미 저장됨 — skip`);
          try { await download.cancel(); } catch (_) {}
          return;
        }
        const dest = path.join(tempDir, `claude-design-${Date.now()}-${fname.replace(/\s+/g, '_')}`);
        try {
          await download.saveAs(dest);
          downloadedPath = dest;
          console.log(`   📥 다운로드 저장: ${dest}`);
        } catch (e) {
          console.error(`   다운로드 저장 실패: ${e.message}`);
        }
      });
    };
    context.on('page', (np) => {
      console.log(`   [context] 새 페이지: ${np.url()}`);
      attachDownloadListener(np, 'new-page');
    });

    page = await context.newPage();
    attachDownloadListener(page, 'main');

    await page.goto('https://claude.ai/design', { waitUntil: 'domcontentloaded' });
    await sleep(5000);

    for (let i = 0; i < 30; i++) {
      const btnCount = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent).length
      ).catch(() => 0);
      if (btnCount >= 3) break;
      await sleep(1000);
    }

    try {
      const skipBtn = await page.$('button:has-text("Skip intro")');
      if (skipBtn) {
        console.log('   "Skip intro" 감지 — 클릭');
        await skipBtn.click({ timeout: 5000 }).catch(async () =>
          await skipBtn.click({ force: true, timeout: 5000 }).catch(() => {})
        );
        await sleep(2000);
      }
    } catch (_) {}

    try {
      const newModalBtn = await page.$('button:has-text("Start designing")');
      if (newModalBtn) {
        console.log('   "What\'s new" 모달 감지 — Start designing 클릭');
        await newModalBtn.click({ timeout: 5000 }).catch(async () =>
          await newModalBtn.click({ force: true, timeout: 5000 }).catch(() => {})
        );
        await sleep(2000);
      }
    } catch (_) {}

    for (let i = 0; i < 3; i++) {
      const backdrop = await page.$('div[data-open][role="presentation"], div[role="dialog"]').catch(() => null);
      if (!backdrop) break;
      console.log(`   잔존 모달 감지 — ESC ${i + 1}/3`);
      await page.keyboard.press('Escape');
      await sleep(800);
    }
    console.log('✅\n');

    console.log('[2/9] 📁 디자인 시작 카드 클릭...');

    let oldUiSuccess = false;
    const projectCreator = await page.$('[data-testid="project-creator"]').catch(() => null);
    if (projectCreator) {
      try {
        await projectCreator.click({ timeout: 5000 });
        await sleep(1500);
        const nameInput = await page.$('input[placeholder="Project name"]').catch(() => null);
        if (nameInput) {
          console.log('   (구 UI 흐름)');
          const projectName = `auto-${Date.now()}`;
          await nameInput.fill(projectName);
          await sleep(500);
          await page.click('button:has-text("High fidelity")').catch(() => {});
          await sleep(500);
          await page.click('[data-testid="create-project-button"]');
          await page.waitForURL(/\/design\/p\//, { timeout: 30000 }).catch(() => {});
          oldUiSuccess = true;
        }
      } catch (_) {}
    }

    if (!oldUiSuccess) {
      console.log('   (신 UI 흐름) Template 드롭다운 → Prototype 선택...');

      await page.waitForSelector('textarea', { timeout: 30000 }).catch(() => {});
      await sleep(1500);

      const chipBtn = await page.evaluateHandle(() => {
        const labelSpans = Array.from(document.querySelectorAll('button span'));
        const labelSpan = labelSpans.find(s => (s.textContent || '').trim() === 'Template');
        if (!labelSpan) return null;
        let el = labelSpan;
        while (el && el.tagName !== 'BUTTON') el = el.parentElement;
        return el;
      }).then(h => h.asElement()).catch(() => null);

      if (chipBtn) {
        try { await chipBtn.click({ timeout: 5000 }); }
        catch (_) { await chipBtn.click({ force: true, timeout: 5000 }); }
        await sleep(1500);

        const dropdownPrototype = await page.locator('button:has-text("Prototype")').last();
        try { await dropdownPrototype.click({ timeout: 5000 }); }
        catch (_) { await dropdownPrototype.click({ force: true, timeout: 5000 }); }
        await sleep(1000);
        console.log('   Template = Prototype 설정 완료');
      } else {
        console.log('   ⚠️ Template chip 못 찾음 — 기본값(None) 그대로 진행');
      }
    }

    await sleep(2000);
    console.log(`   URL: ${page.url()}`);
    console.log('✅\n');

    console.log('[3-5/9] (단계 통합 — skip)\n');

    console.log('[6/9] 📝 프롬프트 입력 + 제출...');
    console.log(`   길이: ${prompt.length}자`);

    const OLD_COMPOSER = '[data-testid="chat-composer-input"]';

    let composerKind = null;
    let newTextarea = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const taHandle = await page.evaluateHandle(() => {
        const tas = Array.from(document.querySelectorAll('textarea')).filter(t => t.offsetParent && !t.disabled);
        return tas.find(t => /min-h-\[48px\]/.test(t.className || '')) || tas[0] || null;
      }).catch(() => null);
      if (taHandle) {
        const elem = taHandle.asElement();
        if (elem) { composerKind = 'new'; newTextarea = elem; break; }
      }
      const old = await page.$(OLD_COMPOSER).catch(() => null);
      if (old) { composerKind = 'old'; break; }
      console.log(`   ⚠️ composer 못 찾음 (${attempt + 1}/3) — URL: ${page.url()}`);
      if (attempt < 2) {
        await sleep(3000);
      }
    }
    if (!composerKind) throw new Error('composer (textarea 또는 chat-composer-input) 못 찾음');
    console.log(`   composer 타입: ${composerKind}`);

    if (composerKind === 'new') {
      try {
        await newTextarea.fill(prompt, { timeout: 10000 });
      } catch (e) {
        console.log(`   fill 실패 (${e.message.split('\n')[0]}) — evaluate fallback`);
        await newTextarea.evaluate((el, text) => {
          el.focus();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(el, text);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, prompt);
      }
      await sleep(800);
      const createBtn = await page.$('button[title="Create"]');
      if (!createBtn) throw new Error('Create 버튼 못 찾음 (title="Create")');
      try { await createBtn.click({ timeout: 5000 }); }
      catch (_) { await createBtn.click({ force: true, timeout: 5000 }); }
      await page.waitForURL(/\/design\/p\//, { timeout: 30000 }).catch(() => {
        console.log(`   ⚠️ URL 이동 안 됨, 현재: ${page.url()}`);
      });
    } else {
      await page.click(OLD_COMPOSER);
      await sleep(300);
      await page.evaluate(({ sel, text }) => {
        const el = document.querySelector(sel);
        if (!el) return;
        el.focus();
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        el.dispatchEvent(new ClipboardEvent('paste', {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        }));
      }, { sel: OLD_COMPOSER, text: prompt });
      await sleep(1500);

      const enteredLen = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? (el.innerText || '').length : 0;
      }, OLD_COMPOSER);
      if (enteredLen < Math.min(prompt.length * 0.5, 50)) {
        console.log(`   ⚠️ paste 입력 부족 (${enteredLen}자) — 줄별 typing fallback`);
        await page.click(OLD_COMPOSER);
        await sleep(300);
        const lines = prompt.split('\n');
        for (let i = 0; i < lines.length; i++) {
          await page.keyboard.type(lines[i], { delay: 0 });
          if (i < lines.length - 1) {
            await page.keyboard.down('Shift');
            await page.keyboard.press('Enter');
            await page.keyboard.up('Shift');
          }
        }
        await sleep(800);
      } else {
        console.log(`   입력 길이: ${enteredLen}자`);
      }
      await page.click('[data-testid="chat-send-button"]');
    }
    console.log('✅\n');

    console.log('[7/9] 💬 후속 질문 응답...');
    console.log('   "Decide for me" 버튼 첫 출현 대기 (최대 5분)...');

    let firstDecideAppeared = false;
    try {
      await page.waitForSelector('button:has-text("Decide for me")', { timeout: 5 * 60 * 1000 });
      firstDecideAppeared = true;
      console.log('   "Decide for me" 버튼 출현');
    } catch (_) {
      console.log('   "Decide for me" 버튼이 5분 안에 안 나타남 (질문 없는 흐름일 수도 있음)');
    }

    let decideClicks = 0;
    if (firstDecideAppeared) {
      const maxDecide = 30;
      for (let i = 0; i < maxDecide; i++) {
        const btn = await page.$('button:has-text("Decide for me")');
        if (!btn) {
          await sleep(2500);
          const again = await page.$('button:has-text("Decide for me")');
          if (!again) break;
        }
        const target = btn || await page.$('button:has-text("Decide for me")');
        if (!target) break;
        try { await target.click({ timeout: 4000 }); }
        catch (_) { await page.evaluate(el => el.click(), target).catch(() => {}); }
        decideClicks++;
        await sleep(1500);
      }
    }
    console.log(`   "Decide for me" 클릭: ${decideClicks}회`);

    try {
      const cont = await page.waitForSelector('button:has-text("Continue")', { timeout: 3 * 60 * 1000 });
      try { await cont.click({ timeout: 5000 }); }
      catch (_) { await page.evaluate(el => el.click(), cont); }
      console.log('   "Continue" 클릭');
    } catch (_) {
      console.log('   "Continue" 버튼 없음');
    }
    console.log('✅\n');

    console.log('[8/9] ⏳ 생성 완료 대기 (URL ?file= 출현)...');
    const pollStart = Date.now();
    const MAX_WAIT_MIN = 30;
    const MAX_ITERATIONS = MAX_WAIT_MIN * 6;

    let fileReady = false;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const url = page.url();
      if (url.includes('?file=') || url.includes('&file=')) {
        fileReady = true;
        const sec = Math.round((Date.now() - pollStart) / 1000);
        const fileParam = decodeURIComponent(url.split(/[?&]file=/)[1].split('&')[0]);
        console.log(`   ✅ 결과 파일 감지 (${sec}초): ${fileParam}`);
        break;
      }
      if (i % 6 === 0) {
        const sec = Math.round((Date.now() - pollStart) / 1000);
        console.log(`   대기 중... (${sec}초) url=${url.slice(0, 80)}`);
      }
      await sleep(10000);
    }

    if (!fileReady) {
      throw new Error(`URL에 ?file= 파라미터가 ${MAX_WAIT_MIN}분 안에 안 나타남 (생성 미완료)`);
    }

    console.log('   claude 응답 완료 대기 (진행 키워드 사라지고 60초 정체, 최대 30분)...');
    const PROGRESS_KEYWORDS = [
      'Designing', 'Working...', 'Working…', 'Refining', 'Refining design', 'Refining logic',
      'Scrambling', 'Sautéing', 'Sauteing', 'Caramelizing', 'Shelling',
      'Boiling', 'Whisking', 'Hmm...', 'Hmm…', 'Thinking', 'Reasoning',
      'Edited', 'Editing', 'Running JS', 'Reading logs', 'Searching for',
      'Set project title', 'Checking', 'Previewing',
    ];
    const respPollStart = Date.now();
    let lastChatText = '';
    let stableSince = null;
    let respDone = false;
    for (let i = 0; i < 180; i++) {
      const lastChat = await page.evaluate(() => {
        const c = document.querySelector('[data-testid="chat-messages"]');
        return c ? (c.innerText || '').slice(-500) : '';
      }).catch(() => '');

      if (lastChat !== lastChatText) {
        lastChatText = lastChat;
        stableSince = Date.now();
      }

      const stableSec = stableSince ? Math.round((Date.now() - stableSince) / 1000) : 0;
      const hasProgress = PROGRESS_KEYWORDS.some(k => lastChat.includes(k));

      if (!hasProgress && stableSec >= 60) {
        const totalSec = Math.round((Date.now() - respPollStart) / 1000);
        console.log(`   ✅ 진행 키워드 없음 + chat 60초 정체 (응답 완료, 총 ${totalSec}초)`);
        respDone = true;
        break;
      }

      if (i % 6 === 0) {
        const totalSec = Math.round((Date.now() - respPollStart) / 1000);
        const flag = hasProgress ? '🔸 진행 중' : '⏸️ 키워드 없음';
        console.log(`   ${flag} (총 ${totalSec}초, 정체 ${stableSec}초) tail="${lastChat.replace(/\n/g, ' ').slice(-80)}"`);
      }
      await sleep(10000);
    }
    if (!respDone) {
      console.log('   ⚠️ 30분 timeout — 그래도 진행');
    }
    await sleep(5000);

    let shareButton = null;
    for (let i = 0; i < 12; i++) {
      const candidates = await page.$$('button:has-text("Share")');
      for (const c of candidates) {
        const isDisabled = await c.evaluate(el =>
          el.disabled || el.getAttribute('aria-disabled') === 'true'
        ).catch(() => true);
        const isVisible = await c.isVisible().catch(() => false);
        if (!isDisabled && isVisible) {
          shareButton = c;
          break;
        }
      }
      if (shareButton) break;
      await sleep(5000);
    }
    if (!shareButton) throw new Error('Share 버튼을 찾지 못함');
    console.log('✅\n');

    console.log('[9/9] 📥 HTML 다운로드...');

    const describe = async (el, label) => {
      try {
        const info = await el.evaluate(e => {
          const r = e.getBoundingClientRect();
          return {
            tag: e.tagName,
            text: (e.textContent || '').trim().slice(0, 40),
            cls: (e.className || '').slice(0, 50),
            visible: !!e.offsetParent,
            disabled: e.disabled,
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          };
        });
        console.log(`   [${label}] ${JSON.stringify(info)}`);
      } catch (_) {}
    };
    const robustClick = async (el, label, postCheck) => {
      try { await el.click({ timeout: 4000 }); console.log(`   ${label} 클릭 (normal)`); return; }
      catch (e1) {
        try { await el.click({ force: true, timeout: 4000 }); console.log(`   ${label} 클릭 (force)`); return; }
        catch (e2) {
          await el.evaluate(node => node.click()).catch(() => {});
          console.log(`   ${label} 클릭 (JS evaluate)`);
        }
      }
    };

    await describe(shareButton, 'Share btn');
    await robustClick(shareButton, 'Share');
    await sleep(3000);

    const modalOpen = await page.evaluate(() => {
      const dlg = document.querySelector('div[role="dialog"], [aria-modal="true"]');
      return dlg ? { found: true, text: (dlg.textContent || '').slice(0, 80) } : { found: false };
    }).catch(() => ({ found: false }));
    console.log(`   Share 모달 상태:`, JSON.stringify(modalOpen));

    let exportTab = await page.$('div[role="dialog"] [role="tab"]:has-text("Export"), [aria-modal="true"] [role="tab"]:has-text("Export")').catch(() => null);
    if (!exportTab) exportTab = await page.waitForSelector('[role="tab"]:has-text("Export")', { timeout: 10000 });
    await describe(exportTab, 'Export tab');
    await robustClick(exportTab, 'Export 탭');
    await sleep(3000);

    let standaloneBtn = await page.$('div[role="dialog"] button:has-text("Standalone HTML"), [aria-modal="true"] button:has-text("Standalone HTML")').catch(() => null);
    if (!standaloneBtn) standaloneBtn = await page.waitForSelector('button:has-text("Standalone HTML")', { timeout: 10000 });
    await describe(standaloneBtn, 'Standalone HTML');
    const standaloneState = await standaloneBtn.evaluate(el => ({
      ariaSelected: el.getAttribute('aria-selected'),
      ariaPressed: el.getAttribute('aria-pressed'),
      dataSelected: el.getAttribute('data-selected'),
      hasSelectedClass: /selected|active|chosen/i.test(el.className || ''),
    })).catch(() => null);
    console.log(`   Standalone selected 상태:`, JSON.stringify(standaloneState));

    const alreadySelected = standaloneState && (
      standaloneState.ariaSelected === 'true' ||
      standaloneState.ariaPressed === 'true' ||
      standaloneState.dataSelected === 'true' ||
      standaloneState.hasSelectedClass
    );

    if (!alreadySelected) {
      await robustClick(standaloneBtn, 'Standalone HTML');
      await sleep(5000);
    } else {
      console.log(`   Standalone HTML 이미 selected → 클릭 skip`);
      await sleep(1500);
    }

    let downloadBtn = await page.$('div[role="dialog"] button:has-text("Download"):visible, [aria-modal="true"] button:has-text("Download"):visible').catch(() => null);
    if (!downloadBtn) downloadBtn = await page.waitForSelector('button:has-text("Download"):visible', { timeout: 10000 });
    await describe(downloadBtn, 'Download (modal)');

    const box = await downloadBtn.boundingBox();
    if (box) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      console.log(`   Download 실제 마우스 클릭 좌표: (${Math.round(cx)}, ${Math.round(cy)})`);
      await page.mouse.move(cx, cy);
      await sleep(150);
      await page.mouse.down();
      await sleep(100);
      await page.mouse.up();
    } else {
      await robustClick(downloadBtn, 'Download (모달)');
    }

    await sleep(3000);
    const chatDebug = await page.evaluate(() => {
      const chat = document.querySelector('[data-testid="chat-messages"]');
      if (!chat) return { foundChat: false };
      const txt = (chat.innerText || '').slice(-300);
      return { foundChat: true, lastTextSnippet: txt };
    }).catch(() => null);
    console.log(`   Download 클릭 후 chat 상태:`, JSON.stringify(chatDebug));

    console.log('   채팅 결과 카드 대기 (최대 20분, ai-Download 아이콘 기반)...');
    const CARD_WAIT_MS = 20 * 60 * 1000;
    const cardLocators = [
      page.locator('i[class*="ai-Download"]').last(),
      page.locator('span').filter({ hasText: /Download.*standalone/i }).first(),
      page.locator('span').filter({ hasText: /Download.*\.html/i }).first(),
      page.locator('div').filter({ hasText: /Download.*standalone/i }).first(),
    ];
    let cardLocator = null;
    const cardStart = Date.now();
    let dbgPrinted = false;
    while (Date.now() - cardStart < CARD_WAIT_MS) {
      for (const loc of cardLocators) {
        const count = await loc.count().catch(() => 0);
        if (count > 0) { cardLocator = loc; break; }
      }
      if (cardLocator) break;

      const elapsed = Math.round((Date.now() - cardStart) / 1000);
      if (!dbgPrinted && elapsed > 300) {
        const dbg = await page.evaluate(() => {
          const dlIcons = Array.from(document.querySelectorAll('[class*="ai-Download"]')).map(el => ({
            cls: (el.className || '').slice(0, 60),
            parentText: (el.parentElement?.textContent || '').trim().slice(0, 80),
          }));
          const downloadTexts = Array.from(document.querySelectorAll('span, div, button, a')).filter(el => {
            const t = (el.textContent || '').trim();
            return /^Download/i.test(t) && t.length < 120;
          }).slice(0, 10).map(el => ({
            tag: el.tagName,
            text: (el.textContent || '').trim().slice(0, 80),
            cls: (el.className || '').slice(0, 50),
          }));
          return { dlIcons, downloadTexts };
        }).catch(() => null);
        console.log(`   [debug 5분] ai-Download 아이콘:`, JSON.stringify(dbg?.dlIcons));
        console.log(`   [debug 5분] "Download" 텍스트 element:`, JSON.stringify(dbg?.downloadTexts));
        dbgPrinted = true;
      }
      if (elapsed > 0 && elapsed % 60 < 5) {
        const chatTail = await page.evaluate(() => {
          const c = document.querySelector('[data-testid="chat-messages"]');
          return c ? (c.innerText || '').slice(-100).replace(/\n/g, ' ') : '';
        }).catch(() => '');
        console.log(`   카드 대기 (${elapsed}초) chat="${chatTail}"`);
      }
      await sleep(5000);
    }
    if (cardLocator) {
      const cardText = await cardLocator.innerText().catch(() => '');
      console.log(`   결과 카드: "${cardText}"`);
    } else {
      console.log(`   ⚠️ 결과 카드 ${CARD_WAIT_MS / 60000}분 안에 안 나타남`);
      cardLocator = cardLocators[0];
    }

    const cardCenter = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('span'));
      const target = spans.find(s => /Download.*standalone/i.test(s.textContent || ''));
      if (!target) return null;
      let el = target;
      for (let i = 0; i < 3 && el.parentElement; i++) el = el.parentElement;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    }).catch(() => null);

    if (cardCenter) {
      console.log(`   결과 카드 좌표: (${Math.round(cardCenter.x)}, ${Math.round(cardCenter.y)}) ${Math.round(cardCenter.w)}x${Math.round(cardCenter.h)}`);
      await page.mouse.move(cardCenter.x, cardCenter.y);
      await sleep(150);
      await page.mouse.down();
      await sleep(100);
      await page.mouse.up();
      console.log('   real mouse click 완료');
    }

    await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('span'));
      const target = spans.find(s => /Download.*standalone/i.test(s.textContent || ''));
      if (!target) return;
      let el = target;
      for (let i = 0; i < 5 && el; i++) {
        try { el.focus && el.focus(); } catch (_) {}
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(t => {
          try {
            const Evt = t.startsWith('pointer') ? PointerEvent : MouseEvent;
            el.dispatchEvent(new Evt(t, { bubbles: true, cancelable: true, buttons: 1 }));
          } catch (_) {}
        });
        try { el.click(); } catch (_) {}
        el = el.parentElement;
      }
    }).catch(() => {});
    console.log('   ancestor 이벤트 dispatch 완료');

    try { await cardLocator.click({ timeout: 3000 }); } catch (_) {
      try { await cardLocator.click({ force: true, timeout: 3000 }); } catch (_) {}
    }

    console.log('   파일 다운로드 대기 (최대 20분)...');

    const initialChatLen = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="chat-messages"]');
      return c ? (c.innerText || '').length : 0;
    }).catch(() => 0);
    await sleep(15000);
    const afterChatLen = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="chat-messages"]');
      return c ? (c.innerText || '').length : 0;
    }).catch(() => 0);

    if (afterChatLen <= initialChatLen + 5 && !downloadedPath) {
      console.log(`   ⚠️ chat 변화 없음 (${initialChatLen}→${afterChatLen}) — 카드 다시 클릭`);
      const iconPos = await page.evaluate(() => {
        const icons = Array.from(document.querySelectorAll('i.ai-Download, [class*="ai-Download"]'));
        for (const i of icons) {
          let p = i.parentElement;
          while (p && p !== document.body) {
            if (/Download.*standalone/i.test(p.textContent || '')) {
              const r = i.getBoundingClientRect();
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }
            p = p.parentElement;
          }
        }
        return null;
      }).catch(() => null);
      if (iconPos) {
        console.log(`   재클릭 좌표 (icon): (${Math.round(iconPos.x)}, ${Math.round(iconPos.y)})`);
        await page.mouse.move(iconPos.x, iconPos.y);
        await sleep(150);
        await page.mouse.down();
        await sleep(100);
        await page.mouse.up();
      } else if (cardCenter) {
        await page.mouse.move(cardCenter.x, cardCenter.y);
        await sleep(200);
        await page.mouse.click(cardCenter.x, cardCenter.y);
        console.log(`   재클릭 (page.mouse.click) at card center`);
      }
    }

    const DOWNLOAD_TIMEOUT_SEC = 1200;
    let blobAnchorClicked = false;
    for (let i = 0; i < DOWNLOAD_TIMEOUT_SEC; i++) {
      if (downloadedPath) break;

      if (!blobAnchorClicked && i >= 3 && i % 3 === 0) {
        const blobInfo = await page.evaluate(() => {
          const withDownload = Array.from(document.querySelectorAll('a[download][href^="blob:"]'));
          const plainBlob = Array.from(document.querySelectorAll('a[href^="blob:"]'));
          const list = [...withDownload, ...plainBlob];
          if (!list.length) return null;
          const a = list[0];
          return { href: a.href, download: a.download };
        }).catch(() => null);
        if (blobInfo) {
          console.log(`   [${i}s] blob anchor 발견 — 자동 클릭: ${blobInfo.download || '(no download attr)'}`);
          await page.evaluate(() => {
            const a = document.querySelector('a[download][href^="blob:"]') || document.querySelector('a[href^="blob:"]');
            if (a) a.click();
          }).catch(() => {});
          blobAnchorClicked = true;
        }
      }

      if (i > 0 && i % 30 === 0) console.log(`   대기 중... (${i}초)`);
      await sleep(1000);
    }
    if (!downloadedPath) throw new Error(`다운로드 파일이 ${DOWNLOAD_TIMEOUT_SEC}초 안에 도착하지 않음`);
    console.log('✅\n');

    console.log('☁️  R2 업로드...');
    const publicUrl = await uploadToR2(downloadedPath);
    console.log(`   ${publicUrl}`);
    console.log('✅\n');

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ 성공!');
    console.log(`Design URL: ${publicUrl}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(JSON.stringify({ success: true, url: publicUrl, localPath: downloadedPath }));

  } catch (error) {
    console.error(`\n❌ 오류: ${error.message}\n`);
    console.error(error.stack);
    if (page) {
      try {
        const screenshotPath = path.join(tempDir, `claude-design-error-${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.error(`스크린샷: ${screenshotPath}`);
      } catch (_) {}
    }
    console.log(JSON.stringify({ success: false, error: error.message }));
    process.exitCode = 1;
  } finally {
    try { await openclaw.browserClose('openclaw'); } catch (_) {}
  }
})();
