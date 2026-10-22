#!/bin/sh
# Puts a backup (tools/backup.sh) back: REPLACES the database and the uploaded files with the backup's.
#   tools/restore.sh /var/backups/communityos/db-20261022-0200.dump [/var/backups/communityos/files-20261022-0200.tgz]
# The app is stopped while it runs (postgres stays up). The database passwords need not match the old server's: logins live outside the backup.
set -eu
DB=${1:?usage: restore.sh db-....dump [files-....tgz]}; FILES=${2:-}
case "$DB" in /*) ;; *) DB="$PWD/$DB" ;; esac
case "$FILES" in ""|/*) ;; *) FILES="$PWD/$FILES" ;; esac
cd "$(dirname "$0")/.."
C="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
printf 'This replaces ALL data on this server with %s. Type yes to go on: ' "$DB"; read -r ok; [ "$ok" = yes ] || { echo "stopped"; exit 1; }
$C up -d postgres
$C stop caddy web api
$C exec -T postgres dropdb -U cos_owner --if-exists communityos
$C exec -T postgres createdb -U cos_owner -O cos_owner communityos
$C exec -T postgres pg_restore -U cos_owner -d communityos --exit-on-error < "$DB"
if [ -n "$FILES" ]; then
  $C run --rm --no-deps -T --entrypoint sh api -c 'rm -rf /data/files/* && tar -C /data -xzf -' < "$FILES"
fi
$C up -d
echo "restored $DB${FILES:+ and $FILES}; the app is starting (docker compose logs -f api)"
