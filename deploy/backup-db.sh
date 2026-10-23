#!/usr/bin/env bash
# Nightly logical backup of the TaskForge production database.
#
# Supabase Free has no backups and no point-in-time recovery, so this is the
# only copy. Dumps go through DIRECT_URL (port 5432, not the pooler — pg_dump
# needs a session-mode connection) in custom format (-Fc: compressed,
# restorable table-by-table with pg_restore). Needs postgresql-client-17 to
# match the 17.x server; pg_dump 16 refuses newer servers.
#
# Local retention is 30 days under ~/backups/taskforge. If R2 backup creds are
# present (BACKUP_R2_* in the same .env), each dump is also copied to that
# bucket by deploy/upload-backup.mjs — a *private* bucket, never the public
# taskforge-files one.
#
# Install:  cp deploy/backup-db.sh ~/bin/taskforge-backup.sh && chmod +x ~/bin/taskforge-backup.sh
#           crontab: 0 9 * * * /home/ubuntu/bin/taskforge-backup.sh >> /home/ubuntu/.pm2/logs/taskforge-backup.log 2>&1
# Restore:  pg_restore --clean --if-exists --no-owner -d "$DIRECT_URL" ~/backups/taskforge/<file>.dump
set -euo pipefail

APP_DIR="${TASKFORGE_APP_DIR:-/home/ubuntu/taskforge-api}"
OUT_DIR="${TASKFORGE_BACKUP_DIR:-/home/ubuntu/backups/taskforge}"
KEEP_DAYS="${TASKFORGE_BACKUP_KEEP_DAYS:-30}"
PG_DUMP="${PG_DUMP:-/usr/lib/postgresql/17/bin/pg_dump}"

DIRECT_URL="$(grep -m1 '^DIRECT_URL=' "$APP_DIR/.env" | cut -d= -f2- | tr -d '"')"
if [[ -z "$DIRECT_URL" ]]; then echo "$(date -u +%FT%TZ) DIRECT_URL not found in $APP_DIR/.env"; exit 1; fi

mkdir -p "$OUT_DIR"
stamp="$(date -u +%Y%m%d-%H%M)"
file="$OUT_DIR/taskforge-$stamp.dump"

start=$(date +%s)
"$PG_DUMP" --no-owner --no-privileges -Fc --dbname="$DIRECT_URL" --file="$file.part"
mv "$file.part" "$file"
size=$(stat -c %s "$file")
echo "$(date -u +%FT%TZ) wrote $file ($size bytes, $(( $(date +%s) - start ))s)"

# Sanity: a dump under 10 KB means pg_dump connected to an empty database.
if (( size < 10240 )); then echo "$(date -u +%FT%TZ) WARNING: dump suspiciously small"; fi

find "$OUT_DIR" -name 'taskforge-*.dump' -mtime +"$KEEP_DAYS" -print -delete | sed 's/^/pruned /'

# Optional off-box copy.
if grep -q '^BACKUP_R2_BUCKET=' "$APP_DIR/.env" && [[ -f "$APP_DIR/deploy/upload-backup.mjs" ]]; then
  (cd "$APP_DIR" && node deploy/upload-backup.mjs "$file") || echo "$(date -u +%FT%TZ) R2 upload failed (local copy kept)"
fi
