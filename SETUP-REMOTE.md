# 원격 자동 실행 설정 가이드 (Claude Code 클라우드 환경)

크몽 봇을 Claude Code 원격 환경(클라우드 컨테이너)에서 자동으로 돌리기 위한 가이드.
위시켓 봇([wishket-automation](https://github.com/teemartbottle/wishket-automation))과 동일한 구조.

## 아키텍처

```
[Routine (매시 정각 등)] → 이 세션에 프롬프트 발사
  → bash run-scheduler.sh
      1. npm install (없을 때만)
      2. scripts/check-setup.js  ← 사전 점검 (실패 시 조용히 종료)
      3. scripts/kmong-scheduler.js
         ├─ Phase 0: kmong-scraper.js          신규 의뢰 수집 (공개 JSON API, 브라우저 불필요)
         ├─ Phase 1: kmong-auto-phase1.js      상세 수집(API) + claude CLI로 제안서/포트폴리오 생성
         ├─ Phase 2: automate-claude-design.js claude.ai/design 시제품 생성 → R2 업로드 → 링크
         └─ Phase 3: automate-kmong-apply.js   제안 폼 입력 + (SKIP_SUBMIT=false일 때만) 실제 제출
      4. data/kmong-seen.json 커밋&푸시 (상태 영속화)
  → 실행 결과를 슬랙 #위시켓-알림 채널에 "[크몽]" 접두사로 공유 (위시켓 봇과 웹훅 공용, 사용자 승인됨)
```

크몽은 댓글 기능이 없어 위시켓 봇의 "비밀 댓글 작성" 단계가 없다. 대신 모든 단계의 결과(성공/실패/드라이런)를
슬랙으로 보고하는 것으로 대체한다.

## 초기 배포 상태: Dry-run

`SKIP_SUBMIT` 환경변수 기본값은 `true`다. 이 상태에서는 Phase 3가 제안 폼에 실제로 값을 입력하고
스크린샷까지 남기지만, 최종 "제출" 버튼은 누르지 않는다. 이유:

- 크몽 "제안하기" 폼은 로그인 후에만 노출되어, 로그인 세션 없이는 정확한 필드 셀렉터(제안 내용
  textarea, 예산/기간 입력란 등)를 검증할 수 없었다.
- 실수로 잘못된 내용을 실제 클라이언트에게 제출하는 사고를 막기 위해 첫 실행은 반드시 dry-run으로
  구조를 확인한 뒤 전환한다.

전환 절차:
1. 로그인 세션 주입 (아래 "로그인 세션 이전" 참고)
2. `SKIP_SUBMIT=true node scripts/automate-kmong-apply.js <프로젝트URL> <제안내용파일> <시제품URL>` 로
   실제 프로젝트 하나에 대해 폼 입력 결과 스크린샷(`temp/kmong-apply-*.png`)을 확인
3. 필드가 잘못 잡히면 `scripts/automate-kmong-apply.js`의 셀렉터를 실제 DOM에 맞게 수정
4. 문제 없으면 `run-scheduler.sh` 또는 Routine 프롬프트에서 `SKIP_SUBMIT=false` 로 전환

## 1회 설정 (사용자가 해야 할 일)

### 0. 자격증명 환경변수 설정 (필수)

Slack 웹훅과 R2 액세스 키는 GitHub secret scanning에 걸려 레포에 커밋할 수 없다. 이 세션(또는
Routine 실행 환경)에 아래 환경변수를 위시켓 봇과 동일한 값으로 설정할 것:

| 환경변수 | 용도 |
|---|---|
| `SLACK_WEBHOOK_URL` | 위시켓 봇이 쓰는 `#위시켓-알림` 웹훅과 동일 값 |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | 위시켓 봇이 쓰는 R2 버킷(`wishket`)과 동일 자격증명 |

미설정 시: Slack 알림은 `data/slack-outbox.jsonl`에 쌓이기만 하고 전송되지 않으며, R2 업로드는
자격증명 오류로 실패한다(Phase 2가 실패로 처리됨).

### 1. 네트워크 정책 허용 (필수)

[Claude Code 환경 설정](https://claude.ai/settings/claude-code) → 해당 환경 → Network policy에서 허용 필요:

| 도메인 | 용도 | 상태 |
|---|---|---|
| `kmong.com` | 의뢰 수집(API) + 제안 제출 | 확인 필요 |
| `hooks.slack.com` | 슬랙 웹훅 알림 | 위시켓 봇에서 이미 허용됐을 가능성 높음 |
| `claude.ai` | 시제품 생성 | 위시켓 봇에서 이미 허용됨 |
| `*.r2.cloudflarestorage.com` | 시제품 HTML 업로드 | 위시켓 봇에서 이미 허용됨 |

### 2. 로그인 세션 이전 (Phase 3 실제 제출에만 필요 — dry-run만 돌릴 거면 생략 가능)

원격 컨테이너는 화면이 없어서 직접 로그인이 불가. 화면이 있는 환경(Mac 등)에서 세션을 내보내 가져온다:

```bash
# 로그인 가능한 환경에서:
node scripts/login-kmong.js       # 브라우저가 뜨면 직접 로그인 후 Enter
node scripts/export-session.js
# → data/session-export.json 생성됨 (크몽 + claude.ai 쿠키)

git add -f data/session-export.json
git commit -m "세션 이전" && git push
```

```bash
# 원격 세션에서:
git pull
node scripts/import-session.js        # 프로필에 주입 + 로그인 상태 실측 검증
node scripts/check-setup.js           # 전체 점검
```

⚠️ `session-export.json`은 로그인 세션 그 자체(`kmong_session`, `x-kmong-authorization` 쿠키 포함)다.
private 저장소 필수, 이전 완료 후 삭제 권장. **절대 채팅/이슈/PR 본문에 쿠키 값을 붙여넣지 말 것.**

### 3. 자동 실행 (Routine)

정기적으로 이 세션으로 발사되는 Routine을 등록해서 사용한다. Claude가 매 회차:
- `bash run-scheduler.sh` 실행
- preflight 실패(네트워크/세션 미설정) 시: 슬랙 알림 없이 스킵
- 제안 완료/실패/드라이런 시: 슬랙 #위시켓-알림에 "[크몽]" 접두사로 결과 공유
- `data/kmong-seen.json` 커밋&푸시로 중복 지원 방지 상태 유지

중지/재개는 세션에서 "크몽 봇 멈춰줘 / 다시 켜줘"라고 하면 됨.

## 수동 실행 명령어

```bash
npm run preflight          # 사전 점검만
bash run-scheduler.sh      # 1회 전체 실행 (preflight 포함, SKIP_SUBMIT=true 기본)
SKIP_SUBMIT=false bash run-scheduler.sh   # 실제 제출까지 수행
node scripts/kmong-auto-phase1.js <프로젝트ID>   # 특정 의뢰 강제 처리
```

## 위시켓 봇과 공유하는 것 / 별도인 것

- 슬랙 웹훅: 공유 (동일 웹훅, 메시지 접두사로 구분) — 사용자 승인됨
- Cloudflare R2 버킷/자격증명: 공유 (업로드 키 접두사 `designs/kmong-design-*`로 구분) — 사용자 승인됨
- 로그인 세션(`.browser-profiles/`), seen 상태(`data/kmong-seen.json`), LLM 프롬프트 템플릿: 완전히 별도
  (레포 자체가 분리되어 있어 자동으로 격리됨)

## 미검증 항목 (실사용 전 확인 필요)

- `scripts/automate-kmong-apply.js`의 폼 필드 셀렉터 — 로그인 세션이 없는 상태에서 작성되어
  텍스트 기반 탐색(가장 큰 textarea = 제안 내용)으로 최선 추정만 해두었다. 첫 dry-run 스크린샷으로
  반드시 확인할 것.
- 크몽이 실제로 텍스트 내 특정 키워드(연락처, 브랜드명 등)를 자동 차단하는지 여부 — 위시켓처럼
  차단 정책이 있을 수 있어 프롬프트에 동일한 금지 규칙을 넣어뒀지만 실사용 전 확인 필요.
