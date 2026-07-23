#!/usr/bin/env bash
# Apply every formal @laundry/db migration exactly once.
#
# The ledger makes the command safe to run repeatedly while rejecting a changed
# historical migration. It intentionally connects as the compose superuser and
# uses SET ROLE laundry_owner for DDL because 0001 makes laundry_owner NOLOGIN.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MIGRATIONS_DIR="${REPO_ROOT}/packages/db/src/migrations"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-laundry-postgres-v2}"

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-8543}"
PGDATABASE="${PGDATABASE:-laundry_v2}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres_secure_password}"
DEFAULT_SUPERUSER_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}"
SUPERUSER_DATABASE_URL="${SUPERUSER_DATABASE_URL:-${DEFAULT_SUPERUSER_URL}}"

die() {
  echo "❌ [migrate-v2] $*" >&2
  exit 1
}

log() {
  echo "=== [migrate-v2] $* ==="
}

container_running() {
  docker inspect -f '{{.State.Running}}' "${POSTGRES_CONTAINER}" 2>/dev/null | grep -qx true
}

migration_files() {
  find "${MIGRATIONS_DIR}" -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]_*.sql' \
    -exec basename {} \; | sort
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi
  shasum -a 256 "$1" | awk '{print $1}'
}

run_psql_url() {
  psql "${SUPERUSER_DATABASE_URL}" -v ON_ERROR_STOP=1 -X -q "$@"
}

run_psql_docker() {
  docker exec -i -e PGPASSWORD="${POSTGRES_PASSWORD}" "${POSTGRES_CONTAINER}" \
    psql -U "${POSTGRES_USER}" -d "${PGDATABASE}" -v ON_ERROR_STOP=1 -X -q "$@"
}

with_psql() {
  if command -v psql >/dev/null 2>&1; then
    run_psql_url "$@"
    return
  fi
  if container_running; then
    run_psql_docker "$@"
    return
  fi
  die "need host psql or running container '${POSTGRES_CONTAINER}'. Start compose first."
}

ensure_ledger() {
  with_psql -c '
    CREATE TABLE IF NOT EXISTS public.laundry_schema_migrations (
      filename text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
    REVOKE ALL ON TABLE public.laundry_schema_migrations FROM PUBLIC;
    REVOKE ALL ON TABLE public.laundry_schema_migrations FROM laundry_app;
  '
}

recorded_checksum() {
  local filename="$1"
  # filename is sourced from the fixed migration filename glob above, never user input.
  with_psql -Atc \
    "SELECT checksum FROM public.laundry_schema_migrations WHERE filename = '${filename}'"
}

apply_migration() {
  local filename="$1"
  local path="${MIGRATIONS_DIR}/${filename}"
  local checksum
  checksum="$(sha256 "${path}")"

  local recorded
  recorded="$(recorded_checksum "${filename}")"
  if [[ -n "${recorded}" ]]; then
    [[ "${recorded}" == "${checksum}" ]] || die "checksum changed for applied migration ${filename}"
    log "Already applied ${filename}"
    return
  fi

  log "Applying ${filename}"
  {
    echo 'BEGIN;'
    if [[ "${filename}" != '0001_roles.sql' ]]; then
      echo 'SET ROLE laundry_owner;'
    fi
    cat "${path}"
    if [[ "${filename}" != '0001_roles.sql' ]]; then
      echo 'RESET ROLE;'
    fi
    echo "INSERT INTO public.laundry_schema_migrations (filename, checksum) VALUES (:'filename', :'checksum');"
    echo 'COMMIT;'
  } | with_psql -v filename="${filename}" -v checksum="${checksum}"
}

main() {
  [[ -d "${MIGRATIONS_DIR}" ]] || die "migrations dir missing: ${MIGRATIONS_DIR}"

  local files=()
  while IFS= read -r file; do
    files+=("${file}")
  done < <(migration_files)
  ((${#files[@]} > 0)) || die "no formal SQL migrations found in ${MIGRATIONS_DIR}"

  ensure_ledger
  local file
  for file in "${files[@]}"; do
    apply_migration "${file}"
  done
  log "OK — ${#files[@]} formal migrations recorded"
}

main "$@"
