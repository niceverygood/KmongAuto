#!/usr/bin/env node
/**
 * R2 업로드 유틸 (위시켓과 동일 버킷, kmong/ 프리픽스 권장)
 * 사용법: node scripts/r2-upload.js <로컬파일경로> <R2키>
 * 예시:   node scripts/r2-upload.js temp/foo.html kmong/foo.html
 */

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const { R2: R2_CONFIG, assertR2 } = require('../lib/secrets');

const CONTENT_TYPES = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript'
};

async function upload(localPath, r2Key) {
  assertR2();
  const client = new S3Client({
    region: 'auto',
    endpoint: R2_CONFIG.endpoint,
    credentials: {
      accessKeyId: R2_CONFIG.accessKeyId,
      secretAccessKey: R2_CONFIG.secretAccessKey
    }
  });

  const file = fs.readFileSync(localPath);
  const ext = path.extname(localPath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';

  await client.send(new PutObjectCommand({
    Bucket: R2_CONFIG.bucket,
    Key: r2Key,
    Body: file,
    ContentType: contentType
  }));

  const publicUrl = `${R2_CONFIG.publicUrl}/${r2Key}`;
  console.log(JSON.stringify({ success: true, url: publicUrl }));
  return publicUrl;
}

if (require.main === module) {
  const [,, localPath, r2Key] = process.argv;

  if (!localPath || !r2Key) {
    console.error('Usage: node r2-upload.js <localPath> <r2Key>');
    process.exit(1);
  }

  upload(localPath, r2Key).catch(e => {
    console.error(JSON.stringify({ success: false, error: e.message }));
    process.exit(1);
  });
}

module.exports = { upload, R2_CONFIG };
