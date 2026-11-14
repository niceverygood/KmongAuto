#!/usr/bin/env node
/**
 * 크몽 "프로젝트 의뢰" 목록 스크래퍼
 *
 * 크몽 커스텀 프로젝트 게시판은 공개 JSON API를 제공한다 (로그인 불필요):
 *   GET https://kmong.com/api/custom-project/v1/requests
 *     ?q=&sort=CREATED_AT&category_list=&sub_category_list=&project_type=&page=1&per_page=30
 *
 * category_list를 비워두면 전체 대분류(IT·프로그래밍, 디자인, 마케팅, 영상·사진·음향 등)를
 * 가져온다. 브라우저 없이 fetch만으로 목록을 가져올 수 있어 위시켓 스크래퍼보다 훨씬
 * 가볍고 안정적이다.
 *
 * stdout에는 JSON 배열만 출력한다 — scheduler/phase1이 stdout 전체를 JSON.parse 하므로
 * 로그는 반드시 stderr로만 남길 것.
 */

const PER_PAGE = 30;
const MAX_PAGES = parseInt(process.env.KMONG_SCRAPE_PAGES || '3', 10);

function buildUrl(page) {
  const params = new URLSearchParams({
    q: '',
    sort: 'CREATED_AT',
    category_list: '', // 전체 카테고리 — IT 외 디자인/마케팅/영상 등도 포함
    sub_category_list: '',
    project_type: 'OUTSOURCING', // 외주(도급)만 — 상주(RESIDENT)는 제외 (위시켓 봇과 동일 정책)
    page: String(page),
    per_page: String(PER_PAGE),
  });
  return `https://kmong.com/api/custom-project/v1/requests?${params.toString()}`;
}

async function fetchPage(page) {
  const url = buildUrl(page);
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} (page ${page})`);
  return res.json();
}

(async () => {
  const results = [];
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await fetchPage(page);
      const requests = data.requests || [];
      console.error(`[scraper] page ${page}: ${requests.length}건 (total ${data.total})`);
      for (const r of requests) {
        results.push({
          id: r.id,
          title: r.title,
          link: `https://kmong.com/custom-project/requests/${r.id}`,
          content: r.content || '',
          amount: r.amount,
          deadline: r.deadline,
          days: r.days,
          isTax: r.is_tax,
          businessType: r.business_type,
          projectType: r.project_type,
          isGovernment: r.is_government,
          breadcrumb: r.breadcrumb,
          category: r.category,
          status: r.status,
        });
      }
      if (!data.next_page_link || requests.length < PER_PAGE) break;
    }
  } catch (err) {
    console.error(`스크래핑 실패: ${err.message}`);
    process.exit(1);
  }

  console.log(JSON.stringify(results, null, 2));
})();
