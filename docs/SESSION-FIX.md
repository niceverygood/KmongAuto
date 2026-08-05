# 크몽 로그인 세션 만료 → 제출 무한 보류 문제 해결

슬랙 `#크몽알림` 에 매일 반복해서 올라오던 알림:

```
[크몽] 로그인 세션 만료 — 제출 보류
대기 중인 신규 의뢰 8건이 있으나, 크몽 세션이 서버 측에서 무효화되어 제출할 수 없습니다.
```

## 1. 원인

크몽 세션은 Playwright persistent profile(`.browser-profiles/kmong`) 안의 쿠키
(`kmong_session`, `XSRF-TOKEN` — Laravel)로만 유지된다.
Laravel 세션은 **마지막 요청 이후** 경과 시간으로 만료되는데,
스케줄러는 **평일 10:30 / 16:00 / 17:00 세 번만** 크몽에 접속한다.

| 구간 | 무접속 시간 |
|---|---|
| 평일 17:00 → 다음날 10:30 | 약 17.5시간 |
| **금요일 17:00 → 월요일 10:30** | **약 65시간** |
| 연휴가 끼면 | 90시간 이상 |

즉 세션이 만료되는 건 이상 동작이 아니라 **현재 구조상 필연**이다.

여기에 복구 경로가 없다는 점이 문제를 무한 보류로 만들었다.
`scripts/automate-kmong-apply.js` 의 세션 확인 단계는 만료를 감지하면 그냥 던지고 끝난다.

```js
if (me.status !== 200 || !me.json) {
  throw new Error(`크몽 로그인 세션 없음/만료 ... — node scripts/login-kmong.js 재실행 필요`);
}
```

사람이 직접 `login-kmong.js` 를 돌려 브라우저에서 로그인하기 전까지
매 회차가 같은 지점에서 실패하고, 대기 의뢰만 쌓인다.
(8월 2일 8건 → 8월 3일 7건으로 줄어든 건 처리된 게 아니라 공고가 마감돼 목록에서 빠진 것이다.)

## 2. 해결 방향

| 계층 | 대응 | 효과 |
|---|---|---|
| 예방 | **1시간마다 keep-alive ping** (주말 포함) | 세션 수명이 계속 갱신돼 애초에 만료되지 않음 |
| 복구 | **자동 재로그인** (저장된 자격증명) | 그래도 만료되면 사람 개입 없이 스스로 복구 |
| 낭비 방지 | **스케줄러 사전 점검** | 세션이 죽었을 때 LLM·시제품 생성을 헛돌리지 않음 |
| 알림 | 복구 실패 시에만 12시간 쓰로틀 알림 | 같은 알림 반복 방지 |

## 3. 추가된 파일

| 파일 | 역할 |
|---|---|
| `lib/kmong-session.js` | 세션 확인 / 자동 재로그인 / 알림 쓰로틀 |
| `scripts/kmong-session-keepalive.js` | keep-alive ping (launchd 1시간 주기) |
| `run-keepalive.sh` | launchd 래퍼 (주말·공휴일에도 실행) |
| `install-keepalive.sh` | launchd 등록/제거 |

기존 파일은 **덮어쓰지 않았다.** 아래 4-3 / 4-4 의 두 군데만 직접 반영하면 된다.

## 4. 적용 방법

### 4-1. 자격증명 등록 (자동 재로그인용)

`config/secrets.json` 에 두 줄 추가:

```json
{
  "kmongEmail": "전문가계정@example.com",
  "kmongPassword": "비밀번호"
}
```

환경변수 `KMONG_EMAIL` / `KMONG_PASSWORD` 도 동일하게 동작하며 이쪽이 우선한다.

> **주의:** 이 저장소는 public 이다. `config/secrets.json` 과 `.env` 는 이번 커밋에서
> `.gitignore` 에 추가했다 — 기존에는 빠져 있어서 시크릿이 커밋될 수 있는 상태였다.
> 실제로 커밋된 이력은 없음을 확인했다 (`git log --all -- config/secrets.json` → 0건).
> 비밀번호를 넣기 전에 이 ignore 가 반영된 상태인지만 확인하면 된다.

자격증명을 넣지 않아도 keep-alive 는 그대로 동작한다.
그 경우 만료 시 자동 복구만 건너뛰고 기존과 동일하게 수동 로그인 알림이 간다 (동작 후퇴 없음).

### 4-2. keep-alive 설치

```bash
cd ~/Projects/KmongAuto
bash install-keepalive.sh
```

즉시 1회 테스트 (창을 띄워 확인):

```bash
node scripts/kmong-session-keepalive.js --headful
```

### 4-3. Phase 3 자동 복구 — `scripts/automate-kmong-apply.js`

상단 require 에 한 줄 추가:

```js
const { ensureSession } = require('../lib/kmong-session');
```

`[4/6] 로그인 세션 확인` 블록을 통째로 교체:

```js
    // 4. 로그인 세션 확인 (+ 만료 시 자동 재로그인)
    console.log('[4/6] 🔐 로그인 세션 확인...');
    const session = await ensureSession(page);
    if (!session.ok) {
      throw new Error(`크몽 로그인 세션 만료 — 자동 복구 실패: ${session.detail}`);
    }
    if (session.recovered) console.log('   ↻ 자동 재로그인으로 복구됨');
    console.log('✅\n');
```

`ensureSession` 은 내부에서 같은 `users/me` 를 호출하므로 기존 판정 기준
(200 + JSON 이 아니면 세션 문제)은 그대로 유지된다.

### 4-4. 스케줄러 사전 점검 — `scripts/kmong-scheduler.js`

지금 구조에서는 세션이 죽어 있어도 **프로젝트마다** Phase 1(LLM, 최대 15분) +
Phase 2(시제품 생성, 최대 50분)를 끝까지 돌린 뒤 Phase 3 에서야 실패한다.
대기 8건이면 한 회차에 최대 **8시간 + AI 크레딧 8건분**을 버린다.

`main()` 의 신규 프로젝트 확인 직후(`if (newProjects.length === 0) ... return;` 아래)에 삽입:

```js
    // 세션 사전 점검 — 죽어 있으면 자동 재로그인, 그래도 실패면 이번 회차 전체 보류.
    // (Phase 1/2 를 헛돌려 AI 크레딧을 낭비하지 않기 위함)
    const preflight = spawnSync('node', [
      path.join(WORKSPACE, 'scripts/kmong-session-keepalive.js'), '--preflight',
    ], { cwd: WORKSPACE, encoding: 'utf-8', timeout: 3 * 60 * 1000 });
    console.log(preflight.stdout || '');

    if (preflight.status !== 0) {
      const list = newProjects.map(p => `- ${p.id} ${p.title}`).join('\n');
      console.log('⏸️  크몽 세션 없음 — 이번 회차 보류 (seen 미추가 → 다음 회차 재시도)');
      await sendSlack(
        `⏸️ [크몽] 로그인 세션 만료 — 제출 보류\n` +
        `대기 중인 신규 의뢰 ${newProjects.length}건이 있으나 세션 자동 복구에 실패했습니다.\n` +
        `👉 \`node scripts/login-kmong.js\` 로 재로그인하면 다음 회차부터 자동 재개됩니다.\n\n` +
        `대기 목록:\n${list}`
      );
      return;
    }
```

`spawnSync` / `path` / `WORKSPACE` / `sendSlack` 는 스케줄러가 이미 import 하고 있다.
보류된 의뢰는 seen 에 추가되지 않으므로 세션 복구 후 다음 회차에 자동으로 다시 처리된다.

### 4-5. 지금 당장 밀린 건 처리

```bash
node scripts/login-kmong.js       # 브라우저에서 1회 로그인
bash run-scheduler.sh             # 대기 의뢰 즉시 처리
```

## 5. 동작 확인

```bash
# 세션 상태만 확인 (재로그인 없이)
node scripts/kmong-session-keepalive.js --no-login ; echo "exit=$?"

# keep-alive 로그
tail -f logs/keepalive-$(date +%Y%m).log

# launchd 등록 확인
launchctl list | grep kmong
```

`data/kmong-session-state.json` 에 마지막 확인/재로그인/알림 시각이 기록된다
(로컬 상태 파일이므로 gitignore 처리됨).

## 6. 한계

- 크몽이 **캡차나 2단계 인증**을 요구하면 자동 재로그인은 불가능하다.
  이 경우 `CAPTCHA` / `VERIFICATION_REQUIRED` 사유로 슬랙 알림이 가고 수동 로그인이 필요하다.
  다만 keep-alive 가 만료 자체를 막아주므로 이 경로에 빠질 일 자체가 크게 줄어든다.
- 로그인 폼은 크몽 UI(모달) 구조에 의존한다. 여러 셀렉터를 순차 시도하도록 작성했지만
  크몽이 로그인 UI를 개편하면 `LOGIN_FORM_NOT_FOUND` 알림과 함께 수동 로그인으로 폴백한다.
- keep-alive 와 스케줄러는 같은 브라우저 프로필을 쓰므로 동시에 열 수 없다.
  `/tmp/kmong-scheduler.lock` 을 확인해 겹치면 keep-alive 가 스스로 건너뛴다.
