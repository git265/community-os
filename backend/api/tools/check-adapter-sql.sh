#!/bin/sh
# Checks every SQL statement of the JDBC adapters against a migrated database, as the role that runs it (PREPARE + EXPLAIN EXECUTE:
# table/column names, parameter types, privileges, row-level security). Usage: tools/check-adapter-sql.sh <statements.sql> [db]
DB=${2:-cos_v2}; H=${PGHOST:-localhost}; P=${PGPORT:-5433}; U=${PGUSER:-postgres}
psql -h $H -p $P -U $U -d $DB -X -q -f "$1" 2>&1 | awk '
  /^== / { name = $0; total++; next }
  /ERROR/ { if (!(name in seen)) { seen[name] = 1; bad++; print name; } print "   " $0 }
  END { if (bad) { print "adapter SQL: " bad " of " total " FAILED"; exit 1 } print "adapter SQL: " total " statements OK" }'
