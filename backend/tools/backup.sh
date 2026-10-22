#!/bin/sh
# A backup of the live data: the database (pg_dump, custom format) and the uploaded files. Run from anywhere; nightly from cron:
#   0 2 * * *  /home/<user>/community-os/backend/tools/backup.sh >> /home/<user>/backup.log 2>&1
# Keeps BACKUP_KEEP_DAYS (14) days in BACKUP_DIR (/var/backups/communityos). With BACKUP_BUCKET set (an S3 / Lightsail / Spaces bucket, and the
# aws CLI configured) each backup is also copied there - keep a copy off the server: a snapshot of the server is lost with the server.
set -eu
PATH="$PATH:/usr/local/bin:/snap/bin"          # cron runs with a short PATH (docker, the aws CLI from snap)
cd "$(dirname "$0")/.."
# BACKUP_* may also be set in .env (read here, so cron needs nothing else)
fromenv() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -1 | sed "s/[[:space:]]#.*$//; s/[[:space:]]*$//; s/^['\"]//; s/['\"]$//"; }
DIR=${BACKUP_DIR:-$(fromenv BACKUP_DIR)}; DIR=${DIR:-/var/backups/communityos}
KEEP=${BACKUP_KEEP_DAYS:-$(fromenv BACKUP_KEEP_DAYS)}; KEEP=${KEEP:-14}
BACKUP_BUCKET=${BACKUP_BUCKET:-$(fromenv BACKUP_BUCKET)}
BACKUP_ENDPOINT=${BACKUP_ENDPOINT:-$(fromenv BACKUP_ENDPOINT)}   # an S3-compatible store that is not AWS (DigitalOcean Spaces: https://blr1.digitaloceanspaces.com)
EP=${BACKUP_ENDPOINT:+--endpoint-url $BACKUP_ENDPOINT}
C="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
stamp=$(date +%Y%m%d-%H%M)
mkdir -p "$DIR"
$C exec -T postgres pg_dump -U cos_owner -d communityos -Fc > "$DIR/db-$stamp.dump.part" && mv "$DIR/db-$stamp.dump.part" "$DIR/db-$stamp.dump"
$C exec -T api tar -C /data -czf - files > "$DIR/files-$stamp.tgz.part" && mv "$DIR/files-$stamp.tgz.part" "$DIR/files-$stamp.tgz"
find "$DIR" -name 'db-*.dump' -mtime +"$KEEP" -delete
find "$DIR" -name 'files-*.tgz' -mtime +"$KEEP" -delete
if [ -n "${BACKUP_BUCKET:-}" ]; then
  aws s3 cp "$DIR/db-$stamp.dump" "s3://$BACKUP_BUCKET/communityos/db-$stamp.dump" --only-show-errors $EP
  aws s3 cp "$DIR/files-$stamp.tgz" "s3://$BACKUP_BUCKET/communityos/files-$stamp.tgz" --only-show-errors $EP
fi
echo "$(date '+%F %T') backup ok: db-$stamp.dump ($(du -h "$DIR/db-$stamp.dump" | cut -f1)), files-$stamp.tgz ($(du -h "$DIR/files-$stamp.tgz" | cut -f1))"
