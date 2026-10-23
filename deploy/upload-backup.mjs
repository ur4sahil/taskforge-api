#!/usr/bin/env node
// Copies one pg_dump file to the private R2 bucket named by BACKUP_R2_BUCKET
// and prunes copies older than BACKUP_R2_KEEP_DAYS (default 30). Called by
// deploy/backup-db.sh after each local dump; safe to run by hand:
//   node deploy/upload-backup.mjs ~/backups/taskforge/taskforge-20261023-0900.dump
//
// Reads R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY from the
// app's .env (same credentials the API uses for attachments). The backups
// bucket is separate from the public taskforge-files bucket on purpose: a
// dump must never be reachable by URL.
import { readFileSync, createReadStream, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

const file = process.argv[2];
if (!file) { console.error('usage: upload-backup.mjs <dump file>'); process.exit(2); }

const envPath = resolve(process.cwd(), '.env');
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }),
);
// The app's R2 token is scoped to the public attachments bucket only, so the
// backups bucket normally gets its own bucket-scoped token (BACKUP_R2_*).
// Fall back to the app token for setups where one token covers both.
const accessKeyId = env.BACKUP_R2_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID;
const secretAccessKey = env.BACKUP_R2_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY;
const missing = [
  ['R2_ACCOUNT_ID', env.R2_ACCOUNT_ID], ['BACKUP_R2_BUCKET', env.BACKUP_R2_BUCKET],
  ['BACKUP_R2_ACCESS_KEY_ID or R2_ACCESS_KEY_ID', accessKeyId], ['BACKUP_R2_SECRET_ACCESS_KEY or R2_SECRET_ACCESS_KEY', secretAccessKey],
].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) { console.error(`missing in .env: ${missing.join(', ')}`); process.exit(2); }

const keepDays = parseInt(env.BACKUP_R2_KEEP_DAYS || '30', 10);
const bucket = env.BACKUP_R2_BUCKET;
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
});

const key = `taskforge/${basename(file)}`;
const size = statSync(file).size;
await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: createReadStream(file), ContentLength: size, ContentType: 'application/octet-stream' }));
console.log(`${new Date().toISOString()} uploaded r2://${bucket}/${key} (${size} bytes)`);

// Prune by key date (the file name carries YYYYMMDD), not by LastModified, so a
// re-upload of an old dump doesn't extend its life.
const cutoff = Date.now() - keepDays * 86400e3;
const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'taskforge/' }));
const old = (listed.Contents || []).filter(o => {
  const m = /taskforge-(\d{4})(\d{2})(\d{2})-/.exec(o.Key || '');
  return m && Date.UTC(+m[1], +m[2] - 1, +m[3]) < cutoff;
});
if (old.length) {
  await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: old.map(o => ({ Key: o.Key })) } }));
  console.log(`pruned ${old.length} old copies: ${old.map(o => o.Key).join(', ')}`);
}
