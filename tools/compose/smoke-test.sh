#!/usr/bin/env bash
# HTTP smoke against the real apps/server PG runtime. This does not rebuild or
# tear down compose, so CI can run it after the migration and RLS gates.
set -euo pipefail

SERVER_URL="${LAUNDRY_SERVER_URL:-http://127.0.0.1:8787}"
COOKIE_JAR="$(mktemp)"
trap 'rm -f "${COOKIE_JAR}"' EXIT

die() {
  echo "❌ [smoke-server] $*" >&2
  exit 1
}

assert_json() {
  local expected_mode="$1"
  node -e '
    const [payload, expectedMode] = process.argv.slice(1);
    const body = JSON.parse(payload);
    if (body.ok !== true || body.data?.mode !== expectedMode || body.data?.platform !== "sql") {
      process.exitCode = 1;
    }
  ' "$2" "${expected_mode}" || die "unexpected health response: $2"
}

health=''
for _ in $(seq 1 30); do
  if health="$(curl --fail --silent --show-error "${SERVER_URL}/health")"; then
    break
  fi
  sleep 1
done
[[ -n "${health}" ]] || die "server did not become healthy at ${SERVER_URL}"
assert_json 'local-pg' "${health}"
echo '✔ [smoke-server] real @laundry/server reports local-pg/sql'

login="$(curl --fail --silent --show-error \
  --cookie-jar "${COOKIE_JAR}" \
  --header 'content-type: application/json' \
  --data '{"org_code":"hongfa","store_code":"main","username":"admin","password":"demo","device_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd"}' \
  "${SERVER_URL}/api/v2/auth/login")" || die 'demo identity login failed'

node -e '
  const body = JSON.parse(process.argv[1]);
  if (body.ok !== true || typeof body.data?.access_token !== "string" || body.data.access_token.length < 10) {
    process.exitCode = 1;
  }
' "${login}" || die "unexpected login response: ${login}"

grep -q 'laundry_refresh' "${COOKIE_JAR}" || die 'login did not set refresh cookie'
echo '✔ [smoke-server] demo identity login uses the real PG runtime'
