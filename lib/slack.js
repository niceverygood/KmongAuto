const fs = require('fs');
const path = require('path');

// 크몽 알림은 #크몽알림 채널 전용 웹훅을 우선 사용하고, 미설정 시 위시켓 봇과 공유하는
// SLACK_WEBHOOK_URL(#위시켓-알림)로 폴백한다. 웹훅 URL은 GitHub secret scanning 대상이라
// 레포에 하드코딩하지 않는다 — KMONG_SLACK_WEBHOOK_URL 환경변수 또는 gitignore된
// data/kmong-webhook.local.json ({"url": "..."}) 로 설정할 것.
function readLocalWebhook() {
  try {
    const f = path.join(__dirname, '../data/kmong-webhook.local.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8')).url || '';
  } catch { /* 무시하고 폴백 */ }
  return '';
}
const SLACK_WEBHOOK_URL = process.env.KMONG_SLACK_WEBHOOK_URL || readLocalWebhook() || process.env.SLACK_WEBHOOK_URL || '';

// 웹훅 실패 시 메시지를 쌓아두는 아웃박스 — 다음 실행/Routine 턴에서 재발송해 알림 유실 방지
const OUTBOX_FILE = path.join(__dirname, '../data/slack-outbox.jsonl');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function appendOutbox(message) {
  try {
    const dir = path.dirname(OUTBOX_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(OUTBOX_FILE, JSON.stringify({ ts: new Date().toISOString(), message }) + '\n');
    console.error(`[slack] 아웃박스에 보관: ${OUTBOX_FILE}`);
  } catch (e) {
    console.error(`[slack] 아웃박스 저장 실패: ${e.message}`);
  }
}

function readOutbox() {
  if (!fs.existsSync(OUTBOX_FILE)) return [];
  return fs.readFileSync(OUTBOX_FILE, 'utf-8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function clearOutbox() {
  if (fs.existsSync(OUTBOX_FILE)) fs.unlinkSync(OUTBOX_FILE);
}

async function postWebhook(message, { retries = 3 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`[slack] failed (${attempt}/${retries}): ${res.status} ${body}`);
        if (res.status < 500) return false;
        lastErr = new Error(`HTTP ${res.status}`);
      } else {
        return true;
      }
    } catch (err) {
      lastErr = err;
      console.error(`[slack] error (${attempt}/${retries}): ${err.message}`);
    }
    if (attempt < retries) await sleep(2000 * attempt);
  }
  console.error(`[slack] all ${retries} attempts failed: ${lastErr?.message}`);
  return false;
}

async function sendSlack(message, opts = {}) {
  if (!SLACK_WEBHOOK_URL) {
    console.log('[slack] webhook not set, skip:', message);
    appendOutbox(message);
    return false;
  }
  const ok = await postWebhook(message, opts);
  if (!ok) appendOutbox(message);
  return ok;
}

async function flushOutbox() {
  const pending = readOutbox();
  if (!pending.length) return { sent: 0, remaining: 0 };
  const stillPending = [];
  let sent = 0;
  for (const item of pending) {
    const ok = await postWebhook(`(지연 발송 ${item.ts})\n${item.message}`, { retries: 1 });
    if (ok) sent++;
    else stillPending.push(item);
  }
  clearOutbox();
  for (const item of stillPending) {
    fs.appendFileSync(OUTBOX_FILE, JSON.stringify(item) + '\n');
  }
  return { sent, remaining: stillPending.length };
}

module.exports = { sendSlack, flushOutbox, readOutbox, clearOutbox, OUTBOX_FILE };
