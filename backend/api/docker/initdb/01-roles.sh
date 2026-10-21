#!/bin/sh
# Runs once, when the postgres container creates its data directory. The two runtime roles must be LOGIN roles themselves
# (BYPASSRLS is not inherited by a member role); the V1 migration only creates them if they are missing, so these attributes stay.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_pw="$COS_APP_PASSWORD" -v platform_pw="$COS_PLATFORM_PASSWORD" <<'SQL'
CREATE ROLE cos_app      LOGIN NOBYPASSRLS PASSWORD :'app_pw';
CREATE ROLE cos_platform LOGIN BYPASSRLS   PASSWORD :'platform_pw';
CREATE ROLE cos_readonly NOLOGIN;
SQL
