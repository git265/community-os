#!/bin/sh
# Migrates a fresh database and runs the database-level tests as the API role.  Usage: tools/test-schema.sh [db]
set -e
DB=${1:-cos_v2_test}; H=${PGHOST:-localhost}; P=${PGPORT:-5433}; U=${PGUSER:-postgres}
"$(dirname "$0")/migrate-local.sh" "$DB"
psql -h $H -p $P -U $U -d "$DB" -v ON_ERROR_STOP=1 -q -f "$(dirname "$0")/../src/test/sql/schema_tests.sql" 2>&1 | grep -v "^NOTICE\|^$\|^ *result\|^-*$\|row)"
