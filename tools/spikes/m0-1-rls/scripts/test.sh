#!/usr/bin/env bash
set -euo pipefail

spike_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$spike_dir"

: "${RLS_DB_PASSWORD:?set RLS_DB_PASSWORD}"
: "${RLS_APP_PASSWORD:?set RLS_APP_PASSWORD}"

docker compose up -d --wait db >/dev/null
docker compose exec -T db psql \
  -v ON_ERROR_STOP=1 \
  -v app_password="$RLS_APP_PASSWORD" \
  -U postgres \
  -d laundry_rls_spike \
  < sql/schema.sql
docker compose exec -T db psql \
  -v ON_ERROR_STOP=1 \
  -U postgres \
  -d laundry_rls_spike \
  < sql/policy-templates.sql
docker compose exec -T db psql \
  -v ON_ERROR_STOP=1 \
  -U postgres \
  -d laundry_rls_spike \
  < sql/seed.sql
docker compose exec -T \
  -e PGPASSWORD="$RLS_APP_PASSWORD" \
  db psql \
  -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 \
  -U laundry_app \
  -d laundry_rls_spike \
  < sql/acceptance.sql
docker compose exec -T \
  -e PGPASSWORD="$RLS_APP_PASSWORD" \
  db psql \
  -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 \
  -U laundry_app \
  -d laundry_rls_spike \
  < sql/worker-missing.sql
