#!/usr/bin/env node

/**
 * 크몽 맞춤 프로젝트 목록 스크래퍼 — 공개 API 사용 (브라우저 불필요).
 *
 * Usage: node scripts/kmong-scraper.js [pages]
 * Output: stdout에 프로젝트 배열 JSON
 *
 * 기본: IT·프로그래밍(category 6) 최신 등록순 1페이지(20개).
 * config/kmong.config.json 의 categoryList / scrapePages 로 조정 가능.
 */

const fs = require('fs');
const path = require('path');
const { fetchRequestList, requestUrl } = require('../lib/kmong-api');

function loadConfig() {
  const p = path.join(__dirname, '../config/kmong.config.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return {}; }
}

(async () => {
  const config = loadConfig();
  const pages = Number(process.argv[2]) || config.scrapePages || 1;
  const categoryList = config.categoryList || '6';

  const all = [];
  for (let page = 1; page <= pages; page++) {
    const data = await fetchRequestList({ categoryList, page, perPage: 20 });
    for (const r of data.requests || []) {
      all.push({
        id: r.id,
        link: requestUrl(r.id),
        title: r.title || '',
        content: r.content || '',
        amount: r.amount ?? null,          // 원 단위 (null/0 = 협의)
        days: r.days ?? null,              // 프로젝트 기간(일)
        deadline: r.deadline ?? null,      // 모집 마감까지 남은 일수
        proposalCount: r.proposal_count ?? 0,
        projectType: r.project_type || '', // OUTSOURCING(외주) | RESIDENT(상주)
        businessType: r.business_type || '',
        isGovernment: !!r.is_government,
        category: r.breadcrumb || (r.category ? `${r.category.cat1_name} / ${r.category.cat2_name}` : ''),
        status: r.status || '',
      });
    }
    if (page >= (data.last_page || 1)) break;
  }

  console.log(JSON.stringify(all, null, 2));
})().catch(err => {
  console.error(`❌ 스크래핑 실패: ${err.message}`);
  process.exit(1);
});
