#!/usr/bin/env bash
# PostgreSQL initdb hook for the two fixed application roles.
# The generated app password travels only over stdin into a psql variable; it is
# never embedded in source SQL, a child argv, or a child environment.
set -euo pipefail
umask 077

: "${POSTGRES_USER:?set PostgreSQL bootstrap user}"
: "${POSTGRES_DB:?set PostgreSQL database name}"
: "${LAUNDRY_APP_PASSWORD:?set generated laundry_app password}"

APP_PASSWORD_VALUE="${LAUNDRY_APP_PASSWORD}"
export -n APP_PASSWORD_VALUE 2>/dev/null || true
unset LAUNDRY_APP_PASSWORD POSTGRES_PASSWORD PGPASSWORD

if [[ "${APP_PASSWORD_VALUE}" == *$'\n'* || "${APP_PASSWORD_VALUE}" == *$'\r'* ]]; then
  echo "❌ [bootstrap-roles] app password cannot contain line breaks" >&2
  exit 1
fi

PSQL_SCRIPT="$(mktemp "${TMPDIR:-/tmp}/laundry-bootstrap-roles.XXXXXX")"
cleanup_bootstrap_roles() {
  rm -f -- "${PSQL_SCRIPT}"
}
trap cleanup_bootstrap_roles EXIT
chmod 600 "${PSQL_SCRIPT}"

cat >"${PSQL_SCRIPT}" <<'SQL'
\prompt '' app_password

BEGIN;

SELECT 'CREATE ROLE laundry_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'laundry_owner'
)
\gexec

SELECT 'CREATE ROLE laundry_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS'
WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'laundry_app'
)
\gexec

ALTER ROLE laundry_owner
  WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

SELECT pg_catalog.format(
  'ALTER ROLE laundry_app WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
  :'app_password'
)
\gexec

SELECT pg_catalog.format(
  'ALTER DATABASE %I OWNER TO laundry_owner',
  :'database_name'
)
\gexec

SELECT pg_catalog.format(
  'GRANT CONNECT ON DATABASE %I TO laundry_app',
  :'database_name'
)
\gexec

COMMIT;
SQL

printf '%s\n' "${APP_PASSWORD_VALUE}" |
  psql --no-password --no-psqlrc --set ON_ERROR_STOP=1 \
    --username "${POSTGRES_USER}" \
    --dbname "${POSTGRES_DB}" \
    --set "database_name=${POSTGRES_DB}" \
    --file "${PSQL_SCRIPT}"
