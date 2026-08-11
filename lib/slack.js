// 크몽 알림용 슬랙 webhook — config/secrets.json 또는 KMONG_SLACK_WEBHOOK_URL 환경변수.
// 크몽 전용 채널을 쓰려면 해당 채널의 webhook으로 교체.
const { SLACK_WEBHOOK_URL } = require('./secrets');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sendSlack(message, { retries = 3 } = {}) {
  if (!SLACK_WEBHOOK_URL) {
    console.log('[slack] webhook not set, skip:', message);
    return false;
  }
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
        if (res.status < 500) return false; // 4xx는 retry 무의미
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

module.exports = { sendSlack };
