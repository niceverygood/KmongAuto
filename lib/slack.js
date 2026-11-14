const fs = require('fs');
const path = require('path');

const CHANNEL_ID = 'C0CG9BJAJE4';
const BOT_TOKEN = process.env.KMONG_SLACK_BOT_TOKEN;

function kmongWebhook() {
  let local = {};
  try {
    local = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/kmong-webhook.local.json'), 'utf8')) || {};
  } catch { /* Environment-only setup is also supported. */ }
  const url = process.env.KMONG_SLACK_WEBHOOK_URL || local.url;
  // A copied shared webhook still posts to its original channel.
  if (!url || url === process.env.SLACK_WEBHOOK_URL) return null;
  return /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url) ? url : null;
}

const endpoint = BOT_TOKEN ? 'https://slack.com/api/chat.postMessage' : kmongWebhook();

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

async function postToKmong(message, { retries = 3 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(BOT_TOKEN && { Authorization: 'Bearer ' + BOT_TOKEN }) },
        body: JSON.stringify(BOT_TOKEN ? { channel: CHANNEL_ID, text: message } : { text: message }),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        console.error(`[slack] failed (${attempt}/${retries}): HTTP ${res.status}`);
        if (res.status < 500) return false;
        lastErr = new Error(`HTTP ${res.status}`);
      } else {
        if (!BOT_TOKEN) return (await res.text()).trim() === 'ok';
        const result = await res.json();
        return result.ok === true && result.channel === CHANNEL_ID;
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
  if (!endpoint) {
    console.error('[slack] 크몽_알림 전송 설정 없음 — 아웃박스에 보관');
    appendOutbox(message);
    return false;
  }
  const ok = await postToKmong(message, opts);
  if (!ok) appendOutbox(message);
  return ok;
}

async function flushOutbox() {
  const pending = readOutbox();
  if (!pending.length) return { sent: 0, remaining: 0 };
  if (!endpoint) return { sent: 0, remaining: pending.length };
  const stillPending = [];
  let sent = 0;
  for (const item of pending) {
    const ok = await postToKmong(`(지연 발송 ${item.ts})\n${item.message}`, { retries: 1 });
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
