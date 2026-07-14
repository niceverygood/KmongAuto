# kmongauto

크몽(kmong.com) "프로젝트 의뢰" 게시판 자동 지원 봇. [wishket-automation](https://github.com/teemartbottle/wishket-automation)의
자매 프로젝트로, 같은 아키텍처(스크래핑 → 제안서 생성 → 시제품 제작 → 자동 제출 → 슬랙 보고)를 크몽에 맞게 이식했다.

Private repo — .env / 자격증명 등 민감 정보를 포함할 수 있음.

자세한 설정/운영 가이드는 [SETUP-REMOTE.md](./SETUP-REMOTE.md) 참고.

## 위시켓 봇과의 차이점

- 크몽은 프로젝트 상세/목록을 공개 JSON API로 제공해 브라우저 없이 스크래핑 가능 (`scripts/kmong-scraper.js`, `kmong-auto-phase1.js`)
- 크몽에는 위시켓의 "비밀 댓글" 같은 기능이 없어 해당 단계가 없음
- 초기 배포는 `SKIP_SUBMIT=true`(dry-run) 기본값 — 폼 입력까지만 자동화하고 실제 제출 버튼은 누르지 않음.
  셀렉터를 실제 로그인 세션으로 검증한 뒤 `SKIP_SUBMIT=false`로 전환할 것.
- Slack 웹훅 / R2 자격증명은 GitHub secret scanning 때문에 레포에 커밋되어 있지 않음 — 배포 환경에서 환경변수로 주입 (SETUP-REMOTE.md 참고)
