#!/usr/bin/env node
/**
 * 시제품 생성 — claude CLI 모드 (claude.ai/design 브라우저 자동화의 폴백)
 *
 * 브라우저 없이 claude CLI(구독 인증)로 단일 standalone HTML 시제품을 생성하고
 * R2에 업로드해 public URL을 반환한다. 원격 headless 환경에서 Cloudflare 챌린지 등으로
 * claude.ai/design 자동화가 막힐 때 사용. (wishket-automation과 동일 — 플랫폼 무관 범용 로직)
 *
 * Usage: node scripts/generate-design-cli.js <prompt-file>
 * Output (stdout 마지막 줄): {"success":true,"url":"https://file.bottlecorp.kr/designs/...html"}
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const { uploadToR2 } = require('../lib/r2');

const promptPath = process.argv[2];
if (!promptPath || !fs.existsSync(promptPath)) {
  console.error('Usage: node generate-design-cli.js <prompt-file>');
  process.exit(1);
}

function findClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try { return execSync('which claude', { encoding: 'utf-8' }).trim(); } catch {}
  return 'claude';
}

const designBrief = fs.readFileSync(promptPath, 'utf-8').trim();

const SYSTEM_PROMPT = `당신은 시니어 프로덕트 디자이너 겸 프론트엔드 개발자다.
아래 디자인 브리프를 바탕으로 클라이언트에게 보여줄 고품질 시제품(프로토타입)을 만든다.

필수 요구사항:
- 단 하나의 self-contained HTML 파일로 출력 (외부 CDN/폰트/이미지 없이 inline CSS/JS만)
- 모바일/데스크톱 반응형
- 실제 서비스처럼 보이는 밀도: 현실적인 한국어 더미 데이터, 3개 이상의 화면/섹션을 탭 또는 네비게이션으로 전환
- 클릭 가능한 인터랙션 (탭 전환, 모달, 폼 등 최소 3개)
- 세련된 최신 UI (일관된 컴러 시스템, 카드/그림자/라운드, 한글 시스템 폰트 스택)

출력 형식: 설명 없이 <!DOCTYPE html>로 시작하는 HTML 코드만 출력한다.
마크다운 코드포스(\`\`\`)로 감싸지 않는다.`;

(async () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🎨 시제품 생성 (claude CLI 모드)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const claudeBin = findClaudeBin();
  console.log(`[1/3] 🤖 claude CLI 생성 중... (${claudeBin})`);

  const fullPrompt = `${SYSTEM_PROMPT}\n\n---\n\n[디자인 브리프]\n${designBrief}`;

  let html;
  try {
    html = execFileSync(claudeBin, ['--print', '--max-turns', '5', '--model', 'sonnet', '--tools', ''], {
      input: fullPrompt,
      encoding: 'utf-8',
      maxBuffer: 30 * 1024 * 1024,
      timeout: 20 * 60 * 1000, // 20분
    });
  } catch (e) {
    console.error(`❌ claude CLI 실패: ${e.message.split('\n')[0]}`);
    console.log(JSON.stringify({ success: false, error: `claude CLI 실패: ${e.message.split('\n')[0]}` }));
    process.exit(1);
  }

  html = (html || '').trim();
  const fenceMatch = html.match(/```(?:html)?\s*([\s\S]*?)```/);
  if (fenceMatch && fenceMatch[1].includes('<html')) html = fenceMatch[1].trim();
  const docIdx = html.search(/<!DOCTYPE\s+html/i);
  if (docIdx > 0) html = html.slice(docIdx);

  if (!/<html[\s>]/i.test(html) || html.length < 3000) {
    console.error(`❌ 생성 결과가 HTML이 아니거나 너무 짧음 (${html.length}자)`);
    console.log(JSON.stringify({ success: false, error: `HTML 생성 실패 (${html.length}자)` }));
    process.exit(1);
  }
  console.log(`✅ HTML ${html.length}자 생성\n`);

  console.log('[2/3] 💾 저장...');
  const outPath = path.join(path.dirname(promptPath), `cli-design-${Date.now()}.html`);
  fs.writeFileSync(outPath, html);
  console.log(`✅ ${outPath}\n`);

  console.log('[3/3] ☁️  R2 업로드...');
  const publicUrl = await uploadToR2(outPath);
  console.log(`✅ ${publicUrl}\n`);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Design URL: ${publicUrl}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log(JSON.stringify({ success: true, url: publicUrl, localPath: outPath, mode: 'cli' }));
})().catch(err => {
  console.error(`❌ 오류: ${err.message}`);
  console.log(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});
