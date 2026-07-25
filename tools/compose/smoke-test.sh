#!/usr/bin/env bash
# HTTP smoke against the real apps/server PG runtime. This does not rebuild or
# tear down compose, so CI can run it after the migration and RLS gates.
set -euo pipefail
umask 077

SERVER_URL="${LAUNDRY_SERVER_URL:-http://127.0.0.1:8787}"
: "${LAUNDRY_LOCAL_ORG_CODE:?set generic local organization code}"
: "${LAUNDRY_LOCAL_STORE_CODE:?set generic local store code}"
: "${LAUNDRY_BOOTSTRAP_ADMIN_USERNAME:?set bootstrap administrator username}"
: "${LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD:?set bootstrap administrator password}"
COOKIE_JAR="$(mktemp)"
LOGIN_REQUEST="$(mktemp)"
LOGIN_RESPONSE="$(mktemp)"
AUTH_HEADER="$(mktemp)"
DIRECTORY_RESPONSE="$(mktemp)"
trap 'rm -f "${COOKIE_JAR}" "${LOGIN_REQUEST}" "${LOGIN_RESPONSE}" "${AUTH_HEADER}" "${DIRECTORY_RESPONSE}"' EXIT

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

node -e '
  process.stdout.write(JSON.stringify({
    org_code: process.env.LAUNDRY_LOCAL_ORG_CODE,
    store_code: process.env.LAUNDRY_LOCAL_STORE_CODE,
    username: process.env.LAUNDRY_BOOTSTRAP_ADMIN_USERNAME,
    password: process.env.LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD,
    device_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  }));
' > "${LOGIN_REQUEST}"

curl --fail --silent --show-error \
  --cookie-jar "${COOKIE_JAR}" \
  --header 'content-type: application/json' \
  --data-binary "@${LOGIN_REQUEST}" \
  --output "${LOGIN_RESPONSE}" \
  "${SERVER_URL}/api/v2/auth/login" || die 'administrator login failed'

node -e '
  const fs = require("node:fs");
  const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const token = body.data?.access_token;
  if (body.ok !== true || typeof token !== "string" || token.length < 10) {
    process.exitCode = 1;
  } else {
    fs.writeFileSync(process.argv[2], `Authorization: Bearer ${token}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.chmodSync(process.argv[2], 0o600);
  }
' "${LOGIN_RESPONSE}" "${AUTH_HEADER}" || die "login response did not contain a valid access token"

grep -q 'laundry_refresh' "${COOKIE_JAR}" || die 'login did not set refresh cookie'
echo '✔ [smoke-server] generic local administrator login uses the real PG runtime'

curl --fail --silent --show-error \
  --header "@${AUTH_HEADER}" \
  --output "${DIRECTORY_RESPONSE}" \
  "${SERVER_URL}/api/v2/local/staff" || die 'staff directory request failed'

node -e '
  const body = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const expectedUsername = process.env.LAUNDRY_BOOTSTRAP_ADMIN_USERNAME;
  if (
    body.ok !== true ||
    !Array.isArray(body.data) ||
    body.data.length !== 1 ||
    body.data[0]?.role !== "admin" ||
    body.data[0]?.username !== expectedUsername
  ) {
    process.exitCode = 1;
  }
' "${DIRECTORY_RESPONSE}" || die "fresh bootstrap staff directory was not administrator-only"

echo '✔ [smoke-server] fresh bootstrap exposes only the real administrator'
