# Database persistence + backups — Railway setup

This is a one-time setup. After you finish, every push will preserve all tournament data, and the system will take a daily backup automatically.

## Step 1 — Mount a Railway volume (fixes the wipe-on-deploy bug)

1. Open your JORD service on https://railway.app/
2. Click **Settings** → scroll to **Volumes** → **+ New Volume**
3. Configure:
   - **Mount path:** `/data`
   - **Size:** 1 GB (way more than enough — DB is ~150KB)
4. Click **Create**

This creates a persistent disk that survives every deploy.

## Step 2 — Tell the app to use the volume

1. In the same service, go to **Variables**
2. Add a new variable:
   - **Key:** `DB_PATH`
   - **Value:** `/data/jord.db`
3. Click **Add**

That's it for persistence. On the next deploy:
- If your current Railway DB has data, it gets copied onto the volume on first boot (one-time migration).
- All future deploys read/write from the volume — no more wipes.

## Step 3 (optional but recommended) — Cloudflare R2 for off-Railway backups

Local backups in the volume are good. Cloud backups protect against the volume itself being wiped or corrupted. Recommend R2 because there are no egress fees (you'll be downloading these).

### Create the R2 bucket

1. Sign up at https://dash.cloudflare.com/ (free)
2. Left sidebar → **R2 Object Storage** → **Create bucket**
3. Bucket name: `jord-backups` (or anything you want)
4. Location: Automatic
5. Click **Create bucket**

### Get API credentials

1. R2 → **Manage R2 API Tokens** → **Create API Token**
2. Permissions: **Object Read & Write**
3. Specify bucket: pick `jord-backups`
4. Click **Create API Token**
5. **Copy the Access Key ID and Secret Access Key** (you only see them once)
6. Also note the **Endpoint** shown — looks like `https://<accountid>.r2.cloudflarestorage.com`

### Add the env vars to Railway

In your JORD service **Variables**, add:

| Key | Value |
|---|---|
| `S3_BUCKET` | `jord-backups` |
| `S3_ENDPOINT` | `https://<accountid>.r2.cloudflarestorage.com` (from step above) |
| `S3_REGION` | `auto` |
| `S3_ACCESS_KEY_ID` | (paste from R2) |
| `S3_SECRET_ACCESS_KEY` | (paste from R2) |

Optional:
- `S3_PREFIX` — folder inside the bucket, default `jord-backups/`

On the next deploy, the daily backup will also upload to R2. The Backups modal in admin will show "Cloud upload: enabled".

## Step 4 — Verify

After the next deploy:

1. Log in as super admin
2. Click **💾 Backups** in the top right of the events list
3. You should see:
   - Latest backup: filename, size, timestamp
   - Local snapshots stored: count (rotated to last 14 days)
   - Cloud upload: enabled (if you did step 3)
   - DB path: `/data/jord.db`
4. Click **↻ Run backup now** to force one immediately
5. Click **⬇ Download backup** to pull a fresh snapshot to your computer

## How it works (for reference)

- **Persistence:** `server.js` reads `DB_PATH` from env. Defaults to `./data/jord.db` for local dev.
- **First-boot migration:** if `DB_PATH` doesn't exist yet but `./data/jord.db` is bundled in the image, it copies the legacy file onto the volume once.
- **Daily backups:** `scripts/backup.js` runs every 24 hours via `setInterval`. Uses better-sqlite3's `db.backup()` (SQLite online backup API — safe with WAL, no lock on the live DB).
- **Local rotation:** keeps last 14 days in `${VOLUME}/backups/`. Older files auto-deleted.
- **Cloud upload:** if `S3_BUCKET` env var is set, the same snapshot is uploaded to S3/R2. If unset, local-only.
- **Manual access:** super admin can hit `POST /api/admin/backup/run` or `GET /api/admin/backup/download` (token in `?token=` or `x-admin-token` header).

## Restoring from a backup

If you ever need to restore:

1. Download the `.db` file (from R2 dashboard or the admin Download Backup button)
2. In Railway → service → **Settings** → connect via Railway CLI: `railway shell`
3. Stop the service or wait for low traffic
4. Replace `/data/jord.db` with the backup file
5. Restart the service

For a hard restore from your laptop, easiest path is:
- Set `DB_PATH=./data/jord.db` locally, drop the backup into `./data/jord.db`, run `npm start` — confirm it loads, then push to Railway (which will copy it up on first boot if the volume is empty, otherwise replace via CLI).
