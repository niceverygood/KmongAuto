#!/usr/bin/env node

/**
 * 크몽 제안서 자동 제출 (Phase 3)
 *
 * 위시켓과 달리 DOM 폼 조작 대신, 로그인된 브라우저 세션 안에서
 * 크몽 공식 제안 API를 직접 호출한다 (프론트 폼이 쓰는 것과 동일한 API).
 *   POST /api/msa/enterprise/v1/projects/proposals
 *   payload: { amount(원), content, days, isTax, requestId, files:null }
 *   응답:    { isSuccess, failReason:{code,message}, proposalId }
 *
 * UI가 바뀌어도 안 깨지고, 성공/실패가 응답으로 명확히 검증됨 (거짓 성공 방지).
 *
 * Usage: node automate-kmong-apply.js <requestId> <proposalContentFile> <termsJsonFile> [figmaUrl]
 */

const fs = require('fs');
const path = require('path');
const { browserStart, browserClose } = require('../lib/browser');

const PROFILE = 'kmong';

const requestId = Number(process.argv[2]);
const proposalContentFile = process.argv[3];
const termsJsonFile = process.argv[4];
const figmaUrl = process.argv[5] || '';

if (!requestId || !proposalContentFile || !termsJsonFile) {
  console.error('Usage: node automate-kmong-apply.js <requestId> <proposalContentFile> <termsJsonFile> [figmaUrl]');
  process.exit(1);
}

function loadConfig() {
  const p = path.join(__dirname, '../config/kmong.config.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return {}; }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📝 크몽 제안서 자동 제출 (Phase 3)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const config = loadConfig();

  // 1. 제안 내용 로드 + 검증
  console.log('[1/6] 📄 제안 내용 로드...');
  if (!fs.existsSync(proposalContentFile)) {
    console.error(`제안 내용 파일 없음: ${proposalContentFile}`);
    process.exit(1);
  }
  let content = fs.readFileSync(proposalContentFile, 'utf-8');

  // 피그마/디자인 URL 치환 (스케줄러가 이미 치환했으면 no-op)
  if (figmaUrl && content.includes('{{FIGMA_URL}}')) {
    content = content.replace(/\{\{FIGMA_URL\}\}/g, figmaUrl);
    fs.writeFileSync(proposalContentFile, content);
    console.log(`   시제품 URL 삽입: ${figmaUrl}`);
  }

  // 미치환 변수 검사 — 있으면 제출하지 않음
  const unresolved = content.match(/\{\{[^}]+\}\}/g);
  if (unresolved) {
    console.error(`❌ 미치환 변수 발견: ${unresolved.join(', ')} — 제출 중단`);
    console.log(JSON.stringify({ success: false, error: `미치환 변수: ${unresolved.join(', ')}` }));
    process.exit(1);
  }

  // 연락처/이메일 마스킹 (크몽이 자동 차단 — 프론트와 동일한 패턴으로 사전 검사)
  const PHONE_RE = /\d{2,3}[-\s]?\d{3,4}[-\s]?\d{4}|\d{10,11}/g;
  const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const phoneHits = content.match(PHONE_RE) || [];
  const emailHits = content.match(EMAIL_RE) || [];
  if (phoneHits.length || emailHits.length) {
    console.log(`   ⚠️ 연락처 패턴 감지 (전화 ${phoneHits.length}, 이메일 ${emailHits.length}) — 자동 마스킹`);
    content = content.replace(EMAIL_RE, '(연락처 생략)').replace(PHONE_RE, '(연락처 생략)');
    fs.writeFileSync(proposalContentFile, content);
  }
  console.log(`   ${content.length}자 로드 완료`);
  if (content.length > 5000) console.log('   ⚠️ 내용이 5000자 초과 — 크몽 길이 제한에 걸릴 수 있음');
  console.log('✅\n');

  // 2. 제안 조건 로드
  console.log('[2/6] 💰 제안 조건 로드...');
  const terms = JSON.parse(fs.readFileSync(termsJsonFile, 'utf-8'));
  const amountManwon = Math.round(Number(terms.amountManwon));
  const days = Math.round(Number(terms.days));
  const minAmount = Number(config.minAmountManwon) || 0;
  if (!amountManwon || amountManwon <= 0) throw new Error(`제안 금액이 유효하지 않음: ${terms.amountManwon}`);
  if (amountManwon < minAmount) throw new Error(`제안 금액 ${amountManwon}만원 < 최소 기준 ${minAmount}만원 — 안전장치로 중단`);
  if (!days || days <= 0) throw new Error(`제안 기간이 유효하지 않음: ${terms.days}`);
  const isTax = config.isTaxInvoiceIssuable !== false;
  console.log(`   금액: ${amountManwon.toLocaleString('ko-KR')}만원 / 기간: ${days}일 / 세금계산서: ${isTax ? '가능' : '불가'}`);
  console.log('✅\n');

  let context;
  try {
    // 3. 브라우저 시작 + 프로젝트 페이지 진입
    console.log('[3/6] 🌐 브라우저 시작 + 프로젝트 페이지 진입...');
    context = await browserStart(PROFILE, { headless: false });
    const page = await context.newPage();
    const projectUrl = `https://kmong.com/enterprise/requests/${requestId}`;
    await page.goto(projectUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    console.log(`   ${projectUrl}`);
    console.log('✅\n');

    // in-page API 호출 헬퍼 (세션 쿠키 + XSRF 토큰 자동 포함)
    const apiCall = (method, apiPath, payload) => page.evaluate(async ({ method, apiPath, payload }) => {
      const xsrfCookie = document.cookie.split('; ').find(c => c.startsWith('XSRF-TOKEN='));
      const token = xsrfCookie ? decodeURIComponent(xsrfCookie.split('=').slice(1).join('=')) : null;
      const headers = {
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      };
      if (payload !== undefined) headers['Content-Type'] = 'application/json';
      if (token) headers['X-XSRF-TOKEN'] = token;
      const res = await fetch(apiPath, {
        method,
        credentials: 'include',
        headers,
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      return { status: res.status, json, text: text.slice(0, 800) };
    }, { method, apiPath, payload });

    // 4. 로그인 세션 확인
    // 크몽 MSA API는 비로그인 시 401이 아니라 HTML 404 페이지를 반환함 —
    // 200 + JSON이 아니면 전부 세션 문제로 간주하고 명확한 메시지로 중단
    console.log('[4/6] 🔐 로그인 세션 확인...');
    const me = await apiCall('GET', '/api/msa/user-app/user/v1/users/me');
    if (me.status !== 200 || !me.json) {
      throw new Error(`크몽 로그인 세션 없음/만료 (users/me HTTP ${me.status}) — node scripts/login-kmong.js 재실행 필요`);
    }
    const username = me.json?.username || me.json?.user?.username || '(이름 확인 불가)';
    console.log(`   로그인 확인: ${username}`);
    console.log('✅\n');

    // 5. 제안 가능 여부 확인 (참고용 — 명시적 불가면 중단)
    console.log('[5/6] 🔍 제안 가능 여부 확인...');
    const avail = await apiCall('GET', `/api/msa/enterprise/v1/projects/proposals/available?requestId=${requestId}`);
    console.log(`   available 응답 (HTTP ${avail.status}): ${JSON.stringify(avail.json ?? avail.text).slice(0, 300)}`);
    const availFlags = avail.json || {};
    const explicitlyUnavailable =
      availFlags.isAvailable === false ||
      availFlags.available === false ||
      availFlags.isProposable === false;
    if (explicitlyUnavailable) {
      const reason = availFlags.reason || availFlags.message || '이미 제안했거나 제안 불가 상태';
      throw new Error(`제안 불가: ${reason}`);
    }
    console.log('✅\n');

    // 6. 제안 제출
    console.log('[6/6] 🚀 제안 제출...');
    const payload = {
      amount: amountManwon * 10000, // 프론트 폼과 동일: 만원 입력 × 10000
      content,
      days,
      isTax,
      requestId,
      files: null,
    };
    const result = await apiCall('POST', '/api/msa/enterprise/v1/projects/proposals', payload);
    console.log(`   제출 응답 (HTTP ${result.status}): ${JSON.stringify(result.json ?? result.text).slice(0, 400)}`);

    const body = result.json || {};
    const proposalId = body.proposalId ?? body.proposal_id ?? null;
    const isSuccess = body.isSuccess === true || (!!proposalId && body.isSuccess !== false);
    const httpOk = result.status >= 200 && result.status < 300;

    if (!httpOk || !isSuccess) {
      const failReason = body.failReason
        ? `${body.failReason.code || ''} ${body.failReason.message || ''}`.trim()
        : (body.message || `HTTP ${result.status}`);
      throw new Error(`제안 제출 실패: ${failReason}`);
    }

    console.log(`   ✅ 제안 제출 성공! proposalId: ${proposalId}`);
    console.log('✅\n');

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🎉 크몽 제안 완료!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(JSON.stringify({
      success: true,
      proposalId,
      requestId,
      amountManwon,
      days,
    }));

    try { await page.close(); } catch (_) {}
    await browserClose(PROFILE);
    process.exit(0);

  } catch (error) {
    console.error(`\n❌ 오류: ${error.message}\n`);
    console.log(JSON.stringify({ success: false, error: error.message }));
    try { await browserClose(PROFILE); } catch (_) {}
    process.exit(1);
  }
})();
