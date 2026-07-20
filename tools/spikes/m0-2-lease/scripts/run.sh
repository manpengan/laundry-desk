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

: "${LEASE_DB_PASSWORD:?set LEASE_DB_PASSWORD}"
: "${LEASE_APP_PASSWORD:?set LEASE_APP_PASSWORD}"
lease_db_port="${LEASE_DB_PORT:-55432}"
mkdir -p evidence

docker compose down -v --remove-orphans >/dev/null 2>&1 || true
docker compose up -d --wait db >/dev/null
docker compose exec -T db psql -At -U postgres -d laundry_lease_spike \
  -c 'select version();' | tee evidence/postgres-version.txt

bash scripts/test.sh 2>&1 | tee evidence/test-suite.txt

export LEASE_DATABASE_URL="postgres://laundry_lease_app:${LEASE_APP_PASSWORD}@127.0.0.1:${lease_db_port}/laundry_lease_spike"
export LEASE_ADMIN_DATABASE_URL="postgres://postgres:${LEASE_DB_PASSWORD}@127.0.0.1:${lease_db_port}/laundry_lease_spike"
node scripts/run-scenarios.mjs | tee evidence/scenarios.jsonl

if rg -n 'Date\.now\(' src > evidence/date-now-static-check.txt; then
  echo 'FAIL: lease validity source contains Date.now()' \
    | tee -a evidence/date-now-static-check.txt
  exit 1
else
  echo 'PASS: no Date.now() in src lease validity paths' \
    | tee evidence/date-now-static-check.txt
fi

rg -n 'FOR UPDATE|verifyLease|invalidated|released-lease|localDeadlineMonoMs|clock_timestamp' src \
  | tee evidence/critical-path-static-check.txt

docker compose exec -T db psql -U postgres -d laundry_lease_spike <<'SQL' \
  | tee evidence/security-introspection.txt
SELECT rolname, rolsuper, rolbypassrls
FROM pg_roles WHERE rolname = 'laundry_lease_app';
SELECT privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'laundry_lease_app'
  AND table_name = 'offline_command_audit'
ORDER BY privilege_type;
SELECT has_table_privilege('laundry_lease_app', 'offline_command_audit', 'UPDATE')
  AS can_update_audit,
  has_table_privilege('laundry_lease_app', 'offline_command_audit', 'DELETE')
  AS can_delete_audit,
  has_table_privilege('laundry_lease_app', 'offline_command_audit', 'TRUNCATE')
  AS can_truncate_audit;
SQL

: > evidence/source-hashes.txt
for source in compose.yaml package.json package-lock.json scripts/*.sh \
  scripts/*.mjs sql/*.sql src/*.mjs test/*.mjs; do
  printf '%s  %s\n' "$(git hash-object "$source")" "$source"
done | tee evidence/source-hashes.txt

normalize_evidence
