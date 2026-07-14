/**
 * Cloudflare R2 업로드 헬퍼 (wishket-automation과 동일 버킷/자격증명 재사용, 사용자 승인됨)
 * 크몽 시제품은 designs/kmong-design-*.html 접두사로 구분해 업로드한다.
 *
 * 액세스 키는 GitHub secret scanning 대상이라 레포에 하드코딩하지 않는다 — 배포 환경(Routine 등)에
 * R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY 환경변수로 위시켓 봇과 동일한 값을 설정할 것.
 */
const fs = require('fs');

const R2 = {
  endpoint: process.env.R2_ENDPOINT || 'https://e1ca9ed3f57c359ae0c7fca430f45281.r2.cloudflarestorage.com',
  accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  bucket: process.env.R2_BUCKET || 'wishket',
  publicUrl: process.env.R2_PUBLIC_URL || 'https://file.bottlecorp.kr',
};

function extractStandaloneFromZip(zipPath) {
  // ZIP에서 (standalone).html 추출 → 임시 .html 경로 반환
  const { execSync } = require('child_process');
  const outPath = zipPath.replace(/\.zip$/i, `-extracted.html`);
  const pyScript = `
import zipfile, sys
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as z:
    entries = z.infolist()
    target = next((i for i in entries if i.filename.endswith('(standalone).html')), None)
    if target is None:
        target = next((i for i in entries if i.filename.endswith('.html') and not i.filename.endswith('.dc.html')), None)
    if target is None:
        target = max((i for i in entries if i.filename.endswith('.html')), key=lambda i: i.file_size, default=None)
    if target is None:
        raise SystemExit('NO_HTML_IN_ZIP')
    print('ENTRY:', target.filename, target.file_size)
    with z.open(target) as r, open(dst, 'wb') as w:
        w.write(r.read())
`;
  const out = execSync(`python3 -c "${pyScript.replace(/"/g, '\\"')}" "${zipPath}" "${outPath}"`, {
    encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024,
  });
  console.log(`   📦 ${out.trim()} → ${outPath}`);
  return outPath;
}

async function uploadToR2(localPath) {
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

  let uploadPath = localPath;
  const head = fs.readFileSync(localPath, { encoding: null }).slice(0, 4);
  const isZip = head[0] === 0x50 && head[1] === 0x4B; // PK
  if (isZip) {
    console.log('   📦 다운로드 파일이 ZIP — standalone.html 추출');
    uploadPath = extractStandaloneFromZip(localPath);
  }

  const client = new S3Client({
    region: 'auto',
    endpoint: R2.endpoint,
    credentials: { accessKeyId: R2.accessKeyId, secretAccessKey: R2.secretAccessKey },
  });
  const body = fs.readFileSync(uploadPath);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const key = `designs/kmong-design-${ts}.html`;
  await client.send(new PutObjectCommand({
    Bucket: R2.bucket, Key: key, Body: body, ContentType: 'text/html; charset=utf-8',
  }));
  return `${R2.publicUrl}/${key}`;
}

module.exports = { R2, uploadToR2, extractStandaloneFromZip };
