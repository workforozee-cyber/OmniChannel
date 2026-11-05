#!/usr/bin/env sh
# Nightly logical backup with 14-day retention. Schedule via cron / a k8s CronJob.
# Restore:  gunzip -c backup.sql.gz | psql "$DATABASE_URL"
# For production also enable your provider's point-in-time recovery (e.g. RDS/Cloud SQL PITR, 7–35 days).
set -eu
: "${DATABASE_URL:?set DATABASE_URL}"
DIR="${BACKUP_DIR:-./backups}"; mkdir -p "$DIR"
FILE="$DIR/omnichannel-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip -9 > "$FILE"
find "$DIR" -name 'omnichannel-*.sql.gz' -mtime +14 -delete
echo "backup written: $FILE"
