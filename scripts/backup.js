/**
 * JORD DB backup module
 *
 * Daily snapshot using better-sqlite3's online backup API (no lock on the live DB),
 * with 14-day local rotation in ${DB_DIR}/backups/, plus optional S3/R2 upload.
 *
 * Usage from server.js:
 *   const backup = require('./scripts/backup');
 *   backup.scheduleDailyBackups(db, DB_PATH);
 *   backup.runBackupNow(db, DB_PATH);   // for the download endpoint
 *
 * S3/R2 upload is gated on env vars. If S3_BUCKET is unset, local-only.
 *   S3_BUCKET, S3_REGION, S3_ENDPOINT (R2: https://<accountid>.r2.cloudflarestorage.com),
 *   S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_PREFIX (optional, defaults to "jord-backups/")
 */

const fs   = require('fs');
const path = require('path');

const KEEP_DAYS    = 14;
const DAY_MS       = 24 * 60 * 60 * 1000;
const BACKUP_DIRNAME = 'backups';

function backupDir(dbPath) {
  return path.join(path.dirname(dbPath), BACKUP_DIRNAME);
}

function ensureBackupDir(dbPath) {
  const dir = backupDir(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function timestamp() {
  // 2026-05-12T14-30-05Z — filename-safe ISO
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
}

/**
 * Take one snapshot. Returns { file, bytes, uploaded }.
 * Throws on failure so the caller can log it.
 */
async function runBackupNow(db, dbPath) {
  const dir  = ensureBackupDir(dbPath);
  const file = path.join(dir, `jord-${timestamp()}.db`);

  // better-sqlite3 online backup — safe with WAL, no lock on the live DB
  await db.backup(file);
  const bytes = fs.statSync(file).size;

  rotateOld(dir);

  let uploaded = false;
  try {
    uploaded = await uploadToS3IfConfigured(file);
  } catch (err) {
    console.error('[Backup] S3 upload failed:', err.message);
  }

  console.log(`[Backup] ${path.basename(file)} (${(bytes / 1024).toFixed(1)} KB)${uploaded ? ' + uploaded' : ''}`);
  return { file, bytes, uploaded };
}

function rotateOld(dir) {
  const cutoff = Date.now() - KEEP_DAYS * DAY_MS;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith('jord-') || !name.endsWith('.db')) continue;
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    } catch {}
  }
}

function listBackups(dbPath) {
  const dir = backupDir(dbPath);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(n => n.startsWith('jord-') && n.endsWith('.db'))
    .map(n => {
      const p = path.join(dir, n);
      const s = fs.statSync(p);
      return { name: n, path: p, bytes: s.size, mtime: s.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

function latestBackup(dbPath) {
  return listBackups(dbPath)[0] || null;
}

/**
 * Schedule daily backups. Runs once at startup (after 60s grace) then every 24h.
 * Returns a stop() function for tests.
 */
function scheduleDailyBackups(db, dbPath) {
  const tick = async () => {
    try { await runBackupNow(db, dbPath); }
    catch (err) { console.error('[Backup] Scheduled backup failed:', err.message); }
  };
  const initial = setTimeout(tick, 60 * 1000);
  const repeat  = setInterval(tick, DAY_MS);
  return () => { clearTimeout(initial); clearInterval(repeat); };
}

// ─── S3 / R2 upload (optional) ───────────────────────────────────────────────

async function uploadToS3IfConfigured(filePath) {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) return false;

  const region    = process.env.S3_REGION || 'auto';
  const endpoint  = process.env.S3_ENDPOINT || undefined;
  const accessKey = process.env.S3_ACCESS_KEY_ID;
  const secretKey = process.env.S3_SECRET_ACCESS_KEY;
  const prefix    = process.env.S3_PREFIX || 'jord-backups/';

  if (!accessKey || !secretKey) {
    console.warn('[Backup] S3_BUCKET set but missing S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY — skipping upload');
    return false;
  }

  let S3Client, PutObjectCommand;
  try {
    ({ S3Client, PutObjectCommand } = require('@aws-sdk/client-s3'));
  } catch {
    console.warn('[Backup] @aws-sdk/client-s3 not installed — run `npm install @aws-sdk/client-s3` to enable cloud backups');
    return false;
  }

  const client = new S3Client({
    region,
    endpoint,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    forcePathStyle: !!endpoint,   // required for R2 and most non-AWS providers
  });

  const key  = prefix + path.basename(filePath);
  const body = fs.readFileSync(filePath);

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key:    key,
    Body:   body,
    ContentType: 'application/octet-stream',
  }));

  return true;
}

module.exports = {
  runBackupNow,
  scheduleDailyBackups,
  listBackups,
  latestBackup,
  backupDir,
};
