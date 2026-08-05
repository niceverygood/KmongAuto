#!/usr/bin/env node

/**
 * 크몽 세션 keep-alive (근본 원인 대응)
 *
 * 스케줄러는 평일 10:30 / 16:00 / 17:00 에만 크몽에 접속한다.
 * 크몽 세션(Laravel kmong_session)은 "마지막 요청 이후" 기준으로 만료되므로
 * 금요일 17:00 → 월요일 10:30 사이 약 65시간의 무접속 구간에서 세션이 죽는다.
 *
 * 이 스크립트를 1시간마다(주말 포함) 돌려 users/me 를 한 번씩 호출하면
 * 세션 수명이 계속 갱신되어 애초에 만료되지 않는다.
 * 이미 만료된 경우에는 저장된 자격증명으로 자동 재로그인까지 시도한다.
 *
 * Usage:
 *   node scripts/kmong-session-keepalive.js             # 조용히 ping (기본, launchd 용)
 *   node scripts/kmong-session-keepalive.js --preflight # 스케줄러 시작 전 사전 점검
 *   node scripts/kmong-session-keepalive.js --headful   # 창 띄우고 실행 (디버깅)
 *   node scripts/kmong-session-keepalive.js --no-login  # 재로그인 없이 확인만
 *
 * Exit code: 0 = 세션 정상(또는 복구됨) / 1 = 사람 개입 필요
 *
 * --preflight 는 스케줄러가 직접 호출하는 용도이므로 스케줄러 lock 을 무시한다.
 * (그 외에는 같은 브라우저 프로필을 동시에 열 수 없으므로 lock 을 존중하고 skip)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { browserStart, browserClose } = require('../lib/browser');
const { ensureSession, shouldAlert, markAlerted, describeReason } = require('../lib/kmong-session');

// slack 모듈이 없어도 스크립트가 죽지 않도록 (콘솔 출력으로 degrade)
let sendSlack = async (msg) => {
  console.log('[slack:noop]', msg);
  return false;
};
try {
  ({ sendSlack } = require('../lib/slack'));
} catch (_) {}

const PROFILE = 'kmong';

// lock 경로는 OS 임시 디렉터리 기준 (macOS/Linux: /tmp, Windows: %TEMP%).
// 스케줄러가 다른 위치의 lock 을 쓴다면 KMONG_SCHEDULER_LOCK 으로 지정.
const TMP = os.tmpdir();
const KEEPALIVE_LOCK = process.env.KMONG_KEEPALIVE_LOCK || path.join(TMP, 'kmong-keepalive.lock');
const SCHEDULER_LOCK = process.env.KMONG_SCHEDULER_LOCK || path.join(TMP, 'kmong-scheduler.lock');

const headful = process.argv.includes('--headful');
const autoLogin = !process.argv.includes('--no-login');
const preflight = process.argv.includes('--preflight');

const ts = () => new Date().toLocaleString('ko-KR');

/** 해당 lock 파일이 살아있는 프로세스를 가리키는지. */
function lockIsAlive(lockFile) {
  try {
    const pid = Number(fs.readFileSync(lockFile, 'utf-8').trim());
    if (!pid) return false;
    process.kill(pid, 0); // 신호 0 = 존재 확인만
    return true;
  } catch {
    return false;
  }
}

(async () => {
  // 스케줄러가 같은 브라우저 프로필(.browser-profiles/kmong)을 쓰는 중이면
  // persistent context 를 동시에 열 수 없다 → 이번 회차는 건너뛴다.
  // (스케줄러가 돌고 있다는 건 곧 크몽에 접속 중이라는 뜻이므로 keep-alive 도 불필요)
  if (!preflight && lockIsAlive(SCHEDULER_LOCK)) {
    console.log(`[${ts()}] 스케줄러 실행 중 — keep-alive skip`);
    process.exit(0);
  }
  if (lockIsAlive(KEEPALIVE_LOCK)) {
    console.log(`[${ts()}] 이전 keep-alive 실행 중 — skip`);
    process.exit(0);
  }

  fs.writeFileSync(KEEPALIVE_LOCK, String(process.pid));
  const cleanupLock = () => {
    try {
      fs.unlinkSync(KEEPALIVE_LOCK);
    } catch {}
  };
  process.on('exit', cleanupLock);

  let context = null;
  let page = null;

  try {
    context = await browserStart(PROFILE, { headless: !headful });
    page = await context.newPage();

    const result = await ensureSession(page, { autoLogin, verbose: true });

    if (result.ok) {
      console.log(
        `[${ts()}] ✅ 세션 정상${result.recovered ? ' (자동 재로그인으로 복구)' : ''} — ${result.username}`
      );

      // 자동 복구된 경우에만 알림 (평상시 ping 은 조용히)
      if (result.recovered) {
        await sendSlack(
          `♻️ [크몽] 세션 만료 감지 → 자동 재로그인 완료 (${ts()})\n` +
            `계정: ${result.username}\n` +
            `대기 중인 의뢰는 다음 회차부터 정상 제출됩니다.`
        );
      }

      try {
        await page.close();
      } catch {}
      await browserClose(PROFILE);
      process.exit(0);
    }

    // 자동 복구 실패 — 사람이 개입해야 함 (12시간에 1회만 알림)
    console.error(`[${ts()}] ❌ 세션 복구 실패: ${result.detail || describeReason(result.reason)}`);

    if (shouldAlert('sessionExpired', 12)) {
      await sendSlack(
        `🔴 [크몽] 로그인 세션 만료 — 자동 복구 실패 (${ts()})\n` +
          `사유: ${result.detail || describeReason(result.reason)}\n` +
          `👉 \`node scripts/login-kmong.js\` 실행 후 브라우저에서 재로그인해주세요.\n` +
          `(이 알림은 세션 복구 전까지 12시간에 1회만 발송됩니다.)`
      );
      markAlerted('sessionExpired');
    } else {
      console.log('   (알림 쓰로틀 — 12시간 내 이미 발송됨)');
    }

    try {
      await page.close();
    } catch {}
    await browserClose(PROFILE);
    process.exit(1);
  } catch (err) {
    // 브라우저 기동 실패(프로필 잠김 등)는 알림 대상이 아님 — 다음 회차에 재시도
    console.error(`[${ts()}] keep-alive 오류: ${err.message}`);
    try {
      await browserClose(PROFILE);
    } catch {}
    process.exit(0);
  }
})();
