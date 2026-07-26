#!/usr/bin/env bash
# HTTP smoke against the real apps/server PG runtime. This does not rebuild or
# tear down compose, so CI can run it after the migration and RLS gates.
set -euo pipefail
umask 077

SERVER_URL="${LAUNDRY_SERVER_URL:-http://127.0.0.1:8787}"
BROWSER_ORIGIN_HEADER='Origin: http://127.0.0.1:5173'
BROWSER_FETCH_SITE_HEADER='Sec-Fetch-Site: same-site'

die() {
  echo "❌ [smoke-server] $*" >&2
  exit 1
}

[[ "${SERVER_URL}" == "http://127.0.0.1:8787" ]] ||
  die "server URL must be the local loopback endpoint"

: "${LAUNDRY_LOCAL_ORG_CODE:?set generic local organization code}"
: "${LAUNDRY_LOCAL_STORE_CODE:?set generic local store code}"
: "${LAUNDRY_BOOTSTRAP_ADMIN_USERNAME:?set bootstrap administrator username}"
: "${LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD:?set bootstrap administrator password}"
LAUNDRY_SMOKE_ADMIN_PASSWORD="${LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD}"
export -n LAUNDRY_SMOKE_ADMIN_PASSWORD
unset \
  LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD \
  LAUNDRY_BOOTSTRAP_ADMIN_PIN \
  POSTGRES_PASSWORD \
  LAUNDRY_APP_PASSWORD \
  DATABASE_URL \
  DATABASE_ADMIN_URL \
  SUPERUSER_DATABASE_URL \
  LAUNDRY_PG_APP_URL \
  PGPASSWORD \
  PGPASSFILE \
  LAUNDRY_ACCESS_TOKEN_SECRET \
  LAUNDRY_CSRF_PROOF_SECRET
COOKIE_JAR="$(mktemp)"
LOGIN_REQUEST="$(mktemp)"
LOGIN_RESPONSE="$(mktemp)"
AUTH_HEADER="$(mktemp)"
DIRECTORY_RESPONSE="$(mktemp)"
trap 'rm -f "${COOKIE_JAR}" "${LOGIN_REQUEST}" "${LOGIN_RESPONSE}" "${AUTH_HEADER}" "${DIRECTORY_RESPONSE}"' EXIT

assert_health_response() {
  node -e '
    try {
      const [payload] = process.argv.slice(1);
      const body = JSON.parse(payload);
      const rootKeys = Object.keys(body).sort().join(",");
      const dataKeys =
        typeof body.data === "object" && body.data !== null
          ? Object.keys(body.data).sort().join(",")
          : "";
      if (
        body.ok !== true ||
        body.data?.status !== "ready" ||
        rootKeys !== "data,ok" ||
        dataKeys !== "status"
      ) {
        process.exitCode = 1;
      }
    } catch {
      process.exitCode = 1;
    }
  ' "$1" 2>/dev/null || die "unexpected health response"
}

health=''
for _ in $(seq 1 30); do
  if health="$(curl --noproxy '*' --fail --silent --show-error "${SERVER_URL}/health" 2>/dev/null)"; then
    break
  fi
  sleep 1
done
[[ -n "${health}" ]] || die "server did not become healthy at ${SERVER_URL}"
assert_health_response "${health}"
echo '✔ [smoke-server] real @laundry/server reports ready'

if ! printf '%s' "${LAUNDRY_SMOKE_ADMIN_PASSWORD}" | node -e '
  try {
    const password = require("node:fs").readFileSync(0, "utf8");
    if (password.length === 0) {
      process.exitCode = 1;
    } else {
      process.stdout.write(JSON.stringify({
        org_code: process.env.LAUNDRY_LOCAL_ORG_CODE,
        store_code: process.env.LAUNDRY_LOCAL_STORE_CODE,
        username: process.env.LAUNDRY_BOOTSTRAP_ADMIN_USERNAME,
        password,
        device_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      }));
    }
  } catch {
    process.exitCode = 1;
  }
' > "${LOGIN_REQUEST}" 2>/dev/null; then
  unset LAUNDRY_SMOKE_ADMIN_PASSWORD
  die 'login request generation failed'
fi
unset LAUNDRY_SMOKE_ADMIN_PASSWORD

curl --noproxy '*' --fail --silent --show-error \
  --cookie-jar "${COOKIE_JAR}" \
  --header "${BROWSER_ORIGIN_HEADER}" \
  --header "${BROWSER_FETCH_SITE_HEADER}" \
  --header 'content-type: application/json' \
  --data-binary "@${LOGIN_REQUEST}" \
  --output "${LOGIN_RESPONSE}" \
  "${SERVER_URL}/api/v2/auth/login" >/dev/null 2>&1 || die 'administrator login failed'

node -e '
  try {
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
  } catch {
    process.exitCode = 1;
  }
' "${LOGIN_RESPONSE}" "${AUTH_HEADER}" 2>/dev/null ||
  die "login response did not contain a valid access token"

grep -q 'laundry_refresh' "${COOKIE_JAR}" || die 'login did not set refresh cookie'
echo '✔ [smoke-server] generic local administrator login uses the real PG runtime'

curl --noproxy '*' --fail --silent --show-error \
  --header "@${AUTH_HEADER}" \
  --header "${BROWSER_ORIGIN_HEADER}" \
  --header "${BROWSER_FETCH_SITE_HEADER}" \
  --output "${DIRECTORY_RESPONSE}" \
  "${SERVER_URL}/api/v2/local/staff" >/dev/null 2>&1 || die 'staff directory request failed'

node -e '
  try {
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
  } catch {
    process.exitCode = 1;
  }
' "${DIRECTORY_RESPONSE}" 2>/dev/null ||
  die "fresh bootstrap staff directory was not administrator-only"

echo '✔ [smoke-server] fresh bootstrap exposes only the real administrator'
