#!/bin/sh
# Applies the Flyway migrations in order to a local database with psql (what Flyway does at start-up). Usage: tools/migrate-local.sh <db>
set -e
DB=${1:-cos_v2}; H=${PGHOST:-localhost}; P=${PGPORT:-5433}; U=${PGUSER:-postgres}
psql -h $H -p $P -U $U -q -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
cd "$(dirname "$0")/../src/main/resources/db/migration"
for f in $(ls V*__*.sql | sort -t_ -k1.2 -n); do
  psql -h $H -p $P -U $U -d $DB -v ON_ERROR_STOP=1 -q -f "$f" > /dev/null 2> /tmp/migrate-$$.err || { echo "FAILED in $f"; grep -v NOTICE /tmp/migrate-$$.err | head -5; exit 1; }
done
echo "migrated $DB"
