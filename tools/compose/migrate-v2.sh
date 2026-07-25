#!/usr/bin/env bash
# Apply every formal @laundry/db migration exactly once.
#
# The ledger makes the command safe to run repeatedly while rejecting a changed
# historical migration. It intentionally connects as the compose superuser and
# uses SET ROLE laundry_owner for DDL because 0001 makes laundry_owner NOLOGIN.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MIGRATIONS_DIR="${REPO_ROOT}/packages/db/src/migrations"
COMPOSE_FILE="${LAUNDRY_COMPOSE_FILE:-${SCRIPT_DIR}/docker-compose.yml}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-laundry-desk}"

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-8543}"
PGDATABASE="${PGDATABASE:-laundry_v2}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
: "${POSTGRES_PASSWORD:?set generated PostgreSQL superuser password}"
ADMIN_PASSWORD_VALUE="${POSTGRES_PASSWORD}"
export -n ADMIN_PASSWORD_VALUE 2>/dev/null || true
unset POSTGRES_PASSWORD PGPASSWORD PGPASSFILE SUPERUSER_DATABASE_URL DATABASE_ADMIN_URL DATABASE_URL

die() {
  echo "❌ [migrate-v2] $*" >&2
  exit 1
}

log() {
  echo "=== [migrate-v2] $* ==="
}

validate_compose_project() {
  [[ ${#COMPOSE_PROJECT_NAME} -le 63 ]] &&
    [[ "${COMPOSE_PROJECT_NAME}" =~ ^laundry-[a-z0-9]([a-z0-9_-]*[a-z0-9])?$ ]] ||
    die "invalid local Compose project"
}

compose_postgres_container() {
  docker compose -p "${COMPOSE_PROJECT_NAME}" -f "${COMPOSE_FILE}" ps -q postgres 2>/dev/null
}

container_running() {
  local container
  container="$(compose_postgres_container)"
  [[ -n "${container}" ]] &&
    docker inspect -f '{{.State.Running}}' "${container}" 2>/dev/null | grep -qx true
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

pgpass_escape() {
  local value
  export -n value 2>/dev/null || true
  value="$1"
  [[ "${value}" != *$'\n'* && "${value}" != *$'\r'* ]] ||
    die "PostgreSQL connection fields cannot contain line breaks"
  value="${value//\\/\\\\}"
  value="${value//:/\\:}"
  printf '%s' "${value}"
}

create_pgpass_file() {
  local host="$1"
  local port="$2"
  local user="$3"
  local password
  local escaped_host escaped_port escaped_database escaped_user escaped_password
  local passfile=""
  export -n password escaped_password 2>/dev/null || true
  password="$4"
  escaped_host="$(pgpass_escape "${host}")" || return 1
  escaped_port="$(pgpass_escape "${port}")" || return 1
  escaped_database="$(pgpass_escape "${PGDATABASE}")" || return 1
  escaped_user="$(pgpass_escape "${user}")" || return 1
  escaped_password="$(pgpass_escape "${password}")" || return 1
  passfile="$(mktemp "${TMPDIR:-/tmp}/laundry-migrate-pgpass.XXXXXX")"
  if ! chmod 600 "${passfile}" ||
    ! printf '%s:%s:%s:%s:%s\n' \
      "${escaped_host}" \
      "${escaped_port}" \
      "${escaped_database}" \
      "${escaped_user}" \
      "${escaped_password}" >"${passfile}"; then
    rm -f -- "${passfile}"
    return 1
  fi
  printf '%s\n' "${passfile}"
}

run_host_psql() (
  local password
  export -n password 2>/dev/null || true
  password="${ADMIN_PASSWORD_VALUE}"
  local passfile=""
  passfile="$(create_pgpass_file "${PGHOST}" "${PGPORT}" "${POSTGRES_USER}" "${password}")" ||
    exit 1
  cleanup_host_pgpass() {
    rm -f -- "${passfile}"
  }
  trap cleanup_host_pgpass EXIT
  PGPASSFILE="${passfile}" psql --no-password \
    -h "${PGHOST}" -p "${PGPORT}" -U "${POSTGRES_USER}" -d "${PGDATABASE}" \
    -v ON_ERROR_STOP=1 -X -q "$@"
)

run_container_psql() (
  local container="$1"
  shift
  local password
  export -n password 2>/dev/null || true
  password="${ADMIN_PASSWORD_VALUE}"
  local host_passfile="" container_passfile=""
  host_passfile="$(
    create_pgpass_file "127.0.0.1" "5432" "${POSTGRES_USER}" "${password}"
  )" || exit 1
  container_passfile="/tmp/$(basename "${host_passfile}")"
  cleanup_container_pgpass() {
    docker exec "${container}" sh -c 'rm -f -- "$1"' sh "${container_passfile}" \
      >/dev/null 2>&1 || true
    rm -f -- "${host_passfile}"
  }
  trap cleanup_container_pgpass EXIT
  docker cp "${host_passfile}" "${container}:${container_passfile}" >/dev/null
  docker exec "${container}" chmod 600 "${container_passfile}"
  docker exec -i -e PGPASSFILE="${container_passfile}" "${container}" \
    psql --no-password -h 127.0.0.1 -p 5432 -U "${POSTGRES_USER}" -d "${PGDATABASE}" \
    -v ON_ERROR_STOP=1 -X -q "$@"
)

run_psql_docker() {
  local container
  container="$(compose_postgres_container)"
  [[ -n "${container}" ]] || die "compose postgres service is not running"
  run_container_psql "${container}" "$@"
}

with_psql() {
  if command -v psql >/dev/null 2>&1; then
    run_host_psql "$@"
    return
  fi
  if container_running; then
    run_psql_docker "$@"
    return
  fi
  die "need host psql or a running compose postgres service. Start compose first."
}

ensure_ledger() {
  with_psql <<'SQL'
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(1279345987, 20260725);
CREATE TABLE IF NOT EXISTS public.laundry_schema_migrations (
  filename text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE public.laundry_schema_migrations FROM PUBLIC;
REVOKE ALL ON TABLE public.laundry_schema_migrations FROM laundry_app;
COMMIT;
SQL
}

apply_migration() {
  local filename="$1"
  local path="${MIGRATIONS_DIR}/${filename}"
  local checksum
  checksum="$(sha256 "${path}")"

  log "Reconciling ${filename}"
  if ! {
    echo 'BEGIN;'
    echo 'SELECT pg_catalog.pg_advisory_xact_lock(1279345987, 20260725);'
    cat <<'SQL'
SELECT
  EXISTS (
    SELECT 1
      FROM public.laundry_schema_migrations
     WHERE filename = :'filename'
  ) AS migration_exists,
  EXISTS (
    SELECT 1
      FROM public.laundry_schema_migrations
     WHERE filename = :'filename'
       AND checksum <> :'checksum'
  ) AS checksum_changed
\gset

\if :checksum_changed
  \echo Checksum changed for applied migration :filename
  SELECT 1 / 0 AS checksum_mismatch;
\endif

\if :migration_exists
  \echo Already applied :filename
\else
SQL
    if [[ "${filename}" != '0001_roles.sql' ]]; then
      echo 'SET ROLE laundry_owner;'
    fi
    cat "${path}"
    if [[ "${filename}" != '0001_roles.sql' ]]; then
      echo 'RESET ROLE;'
    fi
    echo "INSERT INTO public.laundry_schema_migrations (filename, checksum) VALUES (:'filename', :'checksum');"
    cat <<'SQL'
\endif

COMMIT;
SQL
  } | with_psql -v filename="${filename}" -v checksum="${checksum}"; then
    die "migration failed or checksum changed for ${filename}"
  fi
}

main() {
  validate_compose_project
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
