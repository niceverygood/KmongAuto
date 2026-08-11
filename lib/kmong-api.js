/**
 * 크몽 공개 API 클라이언트 (로그인 불필요한 엔드포인트).
 *
 * 크몽 맞춤 프로젝트(enterprise/requests) 목록은 공개 API가 전체 본문까지 반환하므로
 * 위시켓과 달리 목록/상세 수집에 브라우저가 필요 없다.
 *
 *   GET /api/custom-project/v1/requests
 *     params: q, sort(CREATED_AT), category_list, sub_category_list,
 *             project_type(OUTSOURCING|RESIDENT), page, per_page
 *     응답: { total, last_page, requests: [{ id, title, content, amount, days,
 *             deadline, proposal_count, project_type, business_type,
 *             is_government, category: {cat1, cat1_name, cat2, cat2_name} }] }
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function fetchRequestList({ categoryList = '6', projectType = '', page = 1, perPage = 20, sort = 'CREATED_AT' } = {}) {
  const params = new URLSearchParams({
    sort,
    page: String(page),
    per_page: String(perPage),
  });
  if (categoryList) params.set('category_list', categoryList);
  if (projectType) params.set('project_type', projectType);

  const url = `https://kmong.com/api/custom-project/v1/requests?${params.toString()}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`크몽 목록 API 실패: HTTP ${res.status}`);
  return res.json();
}

// 여러 페이지에서 특정 프로젝트 ID 찾기 (phase1 단독 실행용)
async function findRequestById(requestId, { maxPages = 5, categoryList = '6' } = {}) {
  for (let page = 1; page <= maxPages; page++) {
    const data = await fetchRequestList({ categoryList, page, perPage: 50 });
    const found = (data.requests || []).find(r => String(r.id) === String(requestId));
    if (found) return found;
    if (page >= (data.last_page || 1)) break;
  }
  return null;
}

function requestUrl(requestId) {
  return `https://kmong.com/enterprise/requests/${requestId}`;
}

module.exports = { fetchRequestList, findRequestById, requestUrl, UA };
