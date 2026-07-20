#!/usr/bin/env bash
set -euo pipefail

spike_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$spike_dir"

: "${LEASE_DB_PASSWORD:?set LEASE_DB_PASSWORD}"
: "${LEASE_APP_PASSWORD:?set LEASE_APP_PASSWORD}"
lease_db_port="${LEASE_DB_PORT:-55432}"

docker compose up -d --wait db >/dev/null
docker compose exec -T db psql \
  -v ON_ERROR_STOP=1 \
  -v app_password="$LEASE_APP_PASSWORD" \
  -U postgres \
  -d laundry_lease_spike \
  < sql/schema.sql

export LEASE_DATABASE_URL="postgres://laundry_lease_app:${LEASE_APP_PASSWORD}@127.0.0.1:${lease_db_port}/laundry_lease_spike"
export LEASE_ADMIN_DATABASE_URL="postgres://postgres:${LEASE_DB_PASSWORD}@127.0.0.1:${lease_db_port}/laundry_lease_spike"
npm test
