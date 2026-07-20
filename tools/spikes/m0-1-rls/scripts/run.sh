#!/usr/bin/env bash
set -euo pipefail

spike_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$spike_dir"

normalize_evidence() {
  local evidence_file temporary_file
  for evidence_file in evidence/*.txt; do
    temporary_file="${evidence_file}.tmp"
    awk '{ sub(/[[:space:]]+$/, ""); lines[NR] = $0; if ($0 != "") last = NR }
         END { for (line = 1; line <= last; line++) print lines[line] }' \
      "$evidence_file" > "$temporary_file"
    mv "$temporary_file" "$evidence_file"
  done
}

: "${RLS_DB_PASSWORD:?set RLS_DB_PASSWORD}"
: "${RLS_APP_PASSWORD:?set RLS_APP_PASSWORD}"

mkdir -p evidence
docker compose down -v --remove-orphans >/dev/null 2>&1 || true
docker compose up -d --wait db >/dev/null

docker compose exec -T db psql -At -U postgres -d laundry_rls_spike \
  -c 'select version();' | tee evidence/postgres-version.txt

bash scripts/test.sh 2>&1 | tee evidence/isolation-and-fk.txt

docker compose exec -T db psql \
  -v ON_ERROR_STOP=1 \
  -v rls_enabled=true \
  -v benchmark_mode=rls-on \
  -U postgres \
  -d laundry_rls_spike \
  < sql/benchmark.sql | tee evidence/benchmark-rls-on.txt

docker compose exec -T db psql \
  -v ON_ERROR_STOP=1 \
  -v rls_enabled=false \
  -v benchmark_mode=rls-off \
  -U postgres \
  -d laundry_rls_spike \
  < sql/benchmark.sql | tee evidence/benchmark-rls-off.txt

docker compose exec -T db psql -U postgres -d laundry_rls_spike <<'SQL' \
  | tee evidence/schema-introspection.txt
SELECT c.relname, r.rolname AS owner, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class AS c
JOIN pg_roles AS r ON r.oid = c.relowner
WHERE c.relname IN ('orders', 'order_lines', 'garments')
ORDER BY c.relname;
SELECT rolname, rolsuper, rolbypassrls
FROM pg_roles
WHERE rolname IN ('laundry_owner', 'laundry_app')
ORDER BY rolname;
SQL

: > evidence/source-hashes.txt
for source in compose.yaml scripts/*.sh sql/*.sql; do
  printf '%s  %s\n' "$(git hash-object "$source")" "$source"
done | tee evidence/source-hashes.txt

normalize_evidence
