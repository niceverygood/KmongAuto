/**
 * 시크릿 로더 — 공개 저장소에 키가 올라가지 않도록 분리.
 *
 * 우선순위: 환경변수 > config/secrets.json (gitignored)
 * 최초 셋업: config/secrets.example.json 을 config/secrets.json 으로 복사 후 값 입력.
 */

const fs = require('fs');
const path = require('path');

const SECRETS_FILE = path.join(__dirname, '../config/secrets.json');

let s = {};
try { s = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf-8')); } catch {}

const SLACK_WEBHOOK_URL =
  process.env.KMONG_SLACK_WEBHOOK_URL ||
  process.env.SLACK_WEBHOOK_URL ||
  s.slackWebhookUrl || '';

const R2 = {
  endpoint: process.env.R2_ENDPOINT || s.r2?.endpoint || '',
  accessKeyId: process.env.R2_ACCESS_KEY_ID || s.r2?.accessKeyId || '',
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || s.r2?.secretAccessKey || '',
  bucket: process.env.R2_BUCKET || s.r2?.bucket || '',
  publicUrl: process.env.R2_PUBLIC_URL || s.r2?.publicUrl || '',
};

function assertR2() {
  const missing = ['endpoint', 'accessKeyId', 'secretAccessKey', 'bucket', 'publicUrl']
    .filter(k => !R2[k]);
  if (missing.length) {
    throw new Error(
      `R2 설정 누락 (${missing.join(', ')}) — config/secrets.example.json 을 ` +
      `config/secrets.json 으로 복사 후 값을 채우세요`
    );
  }
}

module.exports = { SLACK_WEBHOOK_URL, R2, assertR2 };
