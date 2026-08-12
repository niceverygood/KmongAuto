# KmongAuto (크몽 자동지원)

크몽(kmong.com) 맞춤 프로젝트(`enterprise/requests`) 신규 공고를 자동 감지하여
제안서(제안 내용 + 시제품 링크 + 금액/기간)까지 자동 제출하는 파이프라인.

- **입력**: 크몽 맞춤 프로젝트 목록 (공개 API)
- **출력**: 제안 자동 제출 + 슬랙 알림
- **주기**: 평일 10:30 / 16:00 / 17:00 (launchd 스케줄러)

> 실제 제안 제출(Phase 3)과 놓친 프로젝트 보충은 **크몽에 로그인된 브라우저 세션**이
> 필요하므로, kmong.com 접근이 가능하고 `claude` CLI·claude.ai·R2 설정이 갖춰진
> 환경(보통 로컬 맥)에서 실행해야 한다. 목록 수집/미리보기는 공개 API만 사용한다.

---

## ⚡ 빠른 재가동 (자동지원이 멈췄을 때)

자동지원이 멈추는 가장 흔한 원인은 **`kmong_session` 쿠키 만료**다. 브라우저를 띄워
손으로 다시 로그인할 필요 없이, 개발자도구에서 복사한 세션 쿠키만 주입하면 복구된다.

```bash
npm install
npx playwright install chromium        # 최초 1회

# 1) 세션 복구 — 크몽 로그인 상태에서 개발자도구
#    (Application ▸ Cookies ▸ https://kmong.com ▸ kmong_session) 값을 복사해서:
node scripts/kmong-login-cookie.js "<kmong_session 값 붙여넣기>"
#    또는 요청 헤더의 Cookie 문자열을 통째로:
#    node scripts/kmong-login-cookie.js "kmong_session=...; XSRF-TOKEN=...; x-kmong-auth=..."

# 2) 놓친 프로젝트 미리보기 (제출 안 함, 공개 API만 사용)
node scripts/kmong-backfill.js --pages 5

# 3) 실제 지원 (한 회차 최대 10건, 프로젝트 간 30초 대기)
node scripts/kmong-backfill.js --submit --limit 10

# 3-안정판) 가장 확실하게 — 잘 깨지는 시제품 자동생성(Phase 2)을 건너뜀
node scripts/kmong-backfill.js --submit --no-prototype --portfolio "https://내포트폴리오주소"
```

> **처음엔 `--submit --limit 1` 로 딱 1건만** 넣어보고 실제로 제출되는지 확인한 뒤 건수를 늘리는 걸 권합니다.
> 로그에 어느 Phase에서 막히는지 그대로 찍힙니다.

> ⚠️ `kmong_session` 은 **로그인 세션 토큰(민감정보)**이다. 채팅·이슈·커밋 등에 남기지 말 것.
> 세션 복구용 로컬 파일 경로(`config/kmong-cookies.local.json` 등)는 `.gitignore` 에 등록되어 있다.
> Phase 2(시제품 생성)까지 쓰려면 `node scripts/login-kmong.js` 로 claude.ai 로그인도 1회 세팅해야 한다.

---

## 스크립트 구성

| 스크립트 | 역할 |
|---|---|
| `scripts/kmong-login-cookie.js` | **세션 복구 (쿠키 주입, 비대화형)** — 세션 만료 시 최우선 |
| `scripts/kmong-backfill.js` | **놓친 프로젝트 보충 지원** — 여러 페이지 훑어 미지원 공고 따라잡기 (기본 dry-run) |
| `scripts/kmong-scheduler.js` | 최상위 오케스트레이터 (정규 스케줄) |
| `scripts/kmong-scraper.js` | 목록 수집 (공개 API) |
| `scripts/kmong-auto-phase1.js` | Phase 1 (제안서 생성, claude CLI) |
| `scripts/automate-claude-design.js` | Phase 2 (claude.ai/design 시제품 → R2) |
| `scripts/automate-kmong-apply.js` | Phase 3 (제안 API 제출) |
| `scripts/login-kmong.js` | 초기 로그인 세팅 (크몽 + claude.ai, 대화형) |
| `scripts/r2-upload.js` | R2 업로드 유틸 |
| `lib/browser.js` | Playwright persistent context 래퍼 (프로필: `.browser-profiles/kmong`) |
| `lib/kmong-api.js` | 크몽 공개 API 클라이언트 |
| `lib/slack.js` | 슬랙 webhook 알림 |

## 3단계 파이프라인

### Phase 1 — 프로젝트 수집 및 제안 문안 생성
1. 공개 API로 IT·프로그래밍 카테고리 최신 공고 수집 → seen 대조 신규만
2. 상주(RESIDENT) / UI·UX 전용 / 개발 무관 프로젝트 필터
3. `config/kmong-llm-prompt.md` 에 공고 본문 주입 → claude CLI(구독) 호출
4. 응답 3개 섹션 파싱: 디자인 프롬프트 / 제안 내용 / 제안 조건(JSON: 만원, 일)

### Phase 2 — 시제품(claude.ai/design) 자동 생성 → R2 업로드
Prototype 모드 → 생성 대기 → Standalone HTML 다운로드 → R2 업로드(`designs/kmong-design-*.html`).

### Phase 3 — 크몽 제안 제출 (API 방식)
1. `{{FIGMA_URL}}` 치환 + 미치환 변수 검사 (있으면 제출 중단 + 슬랙 수동 안내)
2. 연락처/이메일 패턴 사전 검사 → 자동 마스킹 (크몽이 자동 차단하는 항목)
3. 로그인 세션 확인 (`/api/msa/user-app/user/v1/users/me`)
4. 제안 가능 여부 확인 (`.../proposals/available`)
5. `POST /api/msa/enterprise/v1/projects/proposals`
   `{ amount(만원×10000), content, days, isTax, requestId, files:null }`
6. 응답의 `isSuccess`/`proposalId` 로 실제 제출 검증 → 실패 시 exit 1 (거짓 성공 방지)

## 놓친 프로젝트 보충 (`kmong-backfill.js`)

스케줄러가 꺼져 있던 동안(세션 만료·컴퓨터 종료) 지나간 공고를 한 번에 따라잡는다.
정규 스케줄러는 최신 1페이지(20개)만 훑지만, backfill 은 여러 페이지를 훑어
seen 에 없는(= 아직 지원 안 한) 공고를 찾는다.

```bash
node scripts/kmong-backfill.js                 # dry-run, 3페이지 미리보기
node scripts/kmong-backfill.js --pages 5       # 5페이지까지
node scripts/kmong-backfill.js --submit        # 실제 제출 (최대 10건)
node scripts/kmong-backfill.js --submit --limit 3
```

**안전장치** (크몽 "단시간 대량 제안" 제재 방지):
- 기본은 **dry-run** — 실제 제출 없이 놓친 후보 목록만 출력(`temp/kmong-backfill-candidates.json` 저장)
- `--submit` 를 줘야 실제 제출. 그때도 스케줄러와 **동일한 필터/seen 규칙**과 프로젝트 간 대기(30초) 적용
- `--limit`(기본 10)로 1회 제출 건수 상한 → 나눠서 실행 유도
- 성공/필터스킵 → seen 추가(재지원 방지), 실패 → seen 미추가(다음에 재시도)

### 시제품 없이 안정적으로 제출 (`--no-prototype`)

자동제출 체인에서 가장 잘 깨지는 부분은 **Phase 2(claude.ai/design 시제품 자동생성)**다.
claude.ai UI에 의존하는 800줄짜리 브라우저 자동화라 UI가 바뀌면 멈추고, 멈추면 제출도 안 된다.

`--no-prototype` 는 이 Phase 2를 통째로 건너뛰고 **제안서 텍스트만으로 제출**한다.
claude CLI(제안서 생성)와 크몽 세션만 있으면 되므로 성공률이 훨씬 높다.

```bash
node scripts/kmong-backfill.js --submit --no-prototype --portfolio "https://내포트폴리오"
# 또는 config 로 상시 적용: kmong.config.json 에 "skipPrototype": true, "portfolioUrl": "https://..."
```

- `--portfolio`(또는 config `portfolioUrl`)를 주면 제안서 맨 위 "서비스 시제품 미리보기: …" 링크가
  그 URL로 채워진다. **안 주면 그 줄은 제거된다** (단, [마무리] 문단의 "시제품 확인" 문구가 살짝
  어색해질 수 있으니 포트폴리오 URL 지정을 권장).
- 대신 프로젝트별 **맞춤 시제품 첨부는 생략**된다. 시제품이 수주 경쟁력에 중요하면 기본(시제품 ON)을 쓰되,
  claude.ai UI에서 Phase 2가 실제로 도는지 먼저 `--submit --limit 1` 로 확인할 것.

## seen 관리

- `data/kmong-seen.json`(gitignored) 에 처리 완료한 request ID 저장
- 성공 / 필터 스킵 → seen 추가 (재지원 방지)
- **실패 → seen 미추가 (다음 회차 자동 재시도)**
- 크몽에서 공고가 내려가면 목록에서 자연 배제

## 초기 셋업

```bash
npm install
npx playwright install chromium
cp config/secrets.example.json config/secrets.json   # R2 키 + 슬랙 webhook 입력
node scripts/login-kmong.js   # 탭1: 크몽 전문가 계정, 탭2: claude.ai 로그인 → Enter
```

- claude CLI 사전 설치 필요 (`claude --print` 사용, 구독 소모)
- 크몽 계정은 **전문가(판매자) 등록 + 엔터프라이즈 프로필 등록**이 되어 있어야 제안 가능
- R2/슬랙 키는 `config/secrets.json`(gitignored, `lib/secrets.js` 로더) — 환경변수로도 override 가능
  (`R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL`, `KMONG_SLACK_WEBHOOK_URL`)

## 스케줄러 등록 (컴퓨터 켜두면 자동 실행)

```bash
bash install-scheduler.sh
# 끄기: launchctl unload -w ~/Library/LaunchAgents/com.bottlecorp.kmong-scheduler.plist
# 즉시 1회 실행(테스트): bash run-scheduler.sh
# 로그: tail -f logs/scheduler-$(date +%Y%m%d).log
```

- 발화 시각: 평일 10:30 / 16:00 / 17:00, 주말·한국 공휴일 자동 skip
- 이전 회차 실행 중이면 새 회차 skip (lock 파일), `caffeinate -i` 로 실행 중 sleep 방지

## 설정 (`config/kmong.config.json`)

| 키 | 기본값 | 설명 |
|---|---|---|
| `categoryList` | `"6"` | 수집 카테고리 (6 = IT·프로그래밍) |
| `scrapePages` | `1` | 목록 수집 페이지 수 (페이지당 20개) |
| `projectTypes` | `["OUTSOURCING"]` | 처리할 진행 방식 (상주 포함하려면 `"RESIDENT"` 추가) |
| `isTaxInvoiceIssuable` | `true` | 세금계산서 발행 가능 여부 (제안 폼 항목) |
| `maxProposalCount` | `999` | 기존 제안 수가 이보다 많으면 스킵 |
| `minAmountManwon` | `100` | 안전장치: 이 금액(만원) 미만 제안은 제출 중단 |
| `delayBetweenProjectsSec` | `30` | 프로젝트 간 대기 |
| `skipPrototype` | `false` | `true` 면 Phase 2(시제품 생성) 항상 건너뜀 (제안서만 제출, 안정성↑) |
| `portfolioUrl` | `""` | 시제품 대신 제안서에 넣을 포트폴리오 링크 (skipPrototype 시 사용) |

## 알려진 이슈 및 대응

| 이슈 | 원인 | 대응 |
|---|---|---|
| 제안 실패: 로그인 세션 만료 | kmong_session 쿠키 만료 | **`node scripts/kmong-login-cookie.js "<값>"`** (쿠키 주입) 또는 `login-kmong.js` |
| 제안 실패: 엔터프라이즈 프로필 | 판매자/엔터프라이즈 프로필 미등록 | kmong.com에서 프로필 등록 (1회) |
| 제안 실패: failReason 코드 | 이미 제안함 / 모집 마감 / 금액 미달 등 | 슬랙 알림의 오류 메시지 확인 |
| Phase 2 다운로드 실패 | claude.ai UI 변경 or 응답 지연 | 셀렉터/타임아웃 조정 |
| API 스키마 변경 | 크몽 프론트 개편 | `lib/kmong-api.js`, `automate-kmong-apply.js` 의 엔드포인트 갱신 |

## 크몽 정책 주의사항

- 제안 내용에 **전화번호·이메일·카톡 등 외부 연락처 기입은 정책 위반**(계정 제재 가능).
  LLM 프롬프트에서 금지 + Phase 3에서 패턴 검사 후 자동 마스킹으로 이중 방어.
- 시제품 링크(file.bottlecorp.kr)는 연락처가 아니므로 포함하되, 크몽 정책 변경 시 모니터링 필요.
- 자동화 계정이 **단시간 대량 제안**을 넣지 않도록 스케줄 3회/일 + 프로젝트 간 30초 대기 유지 권장.
  backfill 로 밀린 공고를 따라잡을 때도 `--limit` 로 나눠서 제출할 것.
