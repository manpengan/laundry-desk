import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const rootUrl = new URL("../../", import.meta.url);
const execFileAsync = promisify(execFile);

async function createHttpSmokeFakes(fixtureDirectory, sentinel) {
  const fakeNode = join(fixtureDirectory, "node");
  const fakeCurl = join(fixtureDirectory, "curl");
  const fakeSleep = join(fixtureDirectory, "sleep");
  const tracePath = join(fixtureDirectory, "subprocess.trace");

  await writeFile(
    fakeNode,
    `#!/usr/bin/env bash
set -euo pipefail
sentinel='${sentinel}'
if env | grep -Fq "\${sentinel}" ||
   env | grep -Eq '^(LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD|LAUNDRY_BOOTSTRAP_ADMIN_PIN|LAUNDRY_SMOKE_ADMIN_PASSWORD|POSTGRES_PASSWORD|LAUNDRY_APP_PASSWORD|DATABASE_URL|DATABASE_ADMIN_URL|SUPERUSER_DATABASE_URL|LAUNDRY_PG_APP_URL|PGPASSWORD|PGPASSFILE|LAUNDRY_ACCESS_TOKEN_SECRET|LAUNDRY_CSRF_PROOF_SECRET)='; then
  exit 91
fi
for argument in "$@"; do
  [[ "\${argument}" != *"\${sentinel}"* ]] || exit 92
done
printf 'node' >> "\${FAKE_TRACE}"
for argument in "$@"; do printf ' <%s>' "\${argument}" >> "\${FAKE_TRACE}"; done
printf '\\n' >> "\${FAKE_TRACE}"
case "\${2:-}" in
  *'body.data?.status !== "ready"'*)
    [[ "\${3:-}" == '{"ok":true,"data":{"status":"ready"}}' ]] || exit 95
    exit 0
    ;;
  *org_code:*)
    password="$(cat)"
    [[ "\${password}" == "\${sentinel}" ]] || exit 93
    printf '{"org_code":"local","store_code":"main","username":"admin","password":"%s","device_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd"}' "\${password}"
    ;;
  *access_token*)
    printf 'Authorization: Bearer safe-access-token\\n' > "\${4}"
    /bin/chmod 600 "\${4}"
    ;;
  *expectedUsername*)
    exit 0
    ;;
  *)
    exit 94
    ;;
esac
`,
  );
  await writeFile(
    fakeCurl,
    `#!/usr/bin/env bash
set -euo pipefail
sentinel='${sentinel}'
if env | grep -Fq "\${sentinel}" ||
   env | grep -Eq '^(LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD|LAUNDRY_BOOTSTRAP_ADMIN_PIN|LAUNDRY_SMOKE_ADMIN_PASSWORD|POSTGRES_PASSWORD|LAUNDRY_APP_PASSWORD|DATABASE_URL|DATABASE_ADMIN_URL|SUPERUSER_DATABASE_URL|LAUNDRY_PG_APP_URL|PGPASSWORD|PGPASSFILE|LAUNDRY_ACCESS_TOKEN_SECRET|LAUNDRY_CSRF_PROOF_SECRET)='; then
  exit 95
fi
for argument in "$@"; do
  [[ "\${argument}" != *"\${sentinel}"* ]] || exit 96
done
printf 'curl' >> "\${FAKE_TRACE}"
for argument in "$@"; do printf ' <%s>' "\${argument}" >> "\${FAKE_TRACE}"; done
printf '\\n' >> "\${FAKE_TRACE}"
output=''
cookie_jar=''
request_file=''
url=''
has_browser_origin=0
has_same_site_fetch=0
has_json_content_type=0
auth_header_file=''
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --cookie-jar) cookie_jar="$2"; shift 2 ;;
    --data-binary) request_file="\${2#@}"; shift 2 ;;
    --header)
      case "$2" in
        'Origin: http://127.0.0.1:5173') has_browser_origin=1 ;;
        'Sec-Fetch-Site: same-site') has_same_site_fetch=1 ;;
        'content-type: application/json') has_json_content_type=1 ;;
        @*) auth_header_file="\${2#@}" ;;
      esac
      shift 2
      ;;
    --*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "\${url}" in
  */health)
    printf '{"ok":true,"data":{"status":"ready"}}'
    ;;
  */api/v2/auth/login)
    [[ "\${has_browser_origin}" == 1 ]] || exit 99
    [[ "\${has_same_site_fetch}" == 1 ]] || exit 100
    [[ "\${has_json_content_type}" == 1 ]] || exit 101
    [[ "$(cat "\${request_file}")" == *"\${sentinel}"* ]] || exit 97
    if [[ "\${FAKE_CURL_FAIL_LOGIN:-0}" == 1 ]]; then
      printf '%s\\n' "\${sentinel} request response safe-access-token"
      printf '%s\\n' "\${sentinel} request response safe-access-token" >&2
      exit 22
    fi
    printf '#HttpOnly_127.0.0.1\\tFALSE\\t/\\tFALSE\\t0\\tlaundry_refresh\\tsafe-refresh-token\\n' > "\${cookie_jar}"
    printf '{"ok":true,"data":{"access_token":"safe-access-token"}}' > "\${output}"
    ;;
  */api/v2/local/staff)
    [[ "\${has_browser_origin}" == 1 ]] || exit 102
    [[ "\${has_same_site_fetch}" == 1 ]] || exit 103
    [[ -f "\${auth_header_file}" ]] || exit 104
    [[ "$(/bin/cat "\${auth_header_file}")" == 'Authorization: Bearer safe-access-token' ]] ||
      exit 105
    printf '{"ok":true,"data":[{"role":"admin","username":"admin"}]}' > "\${output}"
    ;;
  *)
    exit 98
    ;;
esac
`,
  );
  await chmod(fakeNode, 0o700);
  await chmod(fakeCurl, 0o700);
  await writeFile(fakeSleep, "#!/usr/bin/env bash\nexit 0\n");
  await chmod(fakeSleep, 0o700);
  return tracePath;
}

function httpSmokeSecretEnvironment(sentinel) {
  return {
    LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD: sentinel,
    LAUNDRY_BOOTSTRAP_ADMIN_PIN: "482915",
    LAUNDRY_SMOKE_ADMIN_PASSWORD: "preexisting-exported-alias",
    POSTGRES_PASSWORD: "postgres-secret",
    LAUNDRY_APP_PASSWORD: "app-secret",
    DATABASE_URL: "postgresql://laundry_app:app-secret@postgres/laundry_v2",
    DATABASE_ADMIN_URL: "postgresql://postgres:postgres-secret@postgres/laundry_v2",
    SUPERUSER_DATABASE_URL: "postgresql://postgres:postgres-secret@postgres/laundry_v2",
    LAUNDRY_PG_APP_URL: "postgresql://laundry_app:app-secret@postgres/laundry_v2",
    PGPASSWORD: "libpq-secret",
    PGPASSFILE: "/private/pgpass-sentinel",
    LAUNDRY_ACCESS_TOKEN_SECRET: "access-signing-secret",
    LAUNDRY_CSRF_PROOF_SECRET: "csrf-signing-secret",
  };
}

test("keeps the HTTP smoke administrator password out of child argv and environments", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "laundry-http-smoke-env-"));
  const smokeScript = fileURLToPath(new URL("tools/compose/smoke-test.sh", rootUrl));
  const sentinel = "SMOKE-ADMIN-PASSWORD-SENTINEL";

  try {
    const tracePath = await createHttpSmokeFakes(fixtureDirectory, sentinel);
    const result = await execFileAsync("/bin/bash", [smokeScript], {
      env: {
        ...process.env,
        PATH: `${fixtureDirectory}:${process.env.PATH ?? ""}`,
        TMPDIR: fixtureDirectory,
        FAKE_TRACE: tracePath,
        LAUNDRY_LOCAL_ORG_CODE: "local",
        LAUNDRY_LOCAL_STORE_CODE: "main",
        LAUNDRY_BOOTSTRAP_ADMIN_USERNAME: "admin",
        ...httpSmokeSecretEnvironment(sentinel),
      },
    });

    const trace = await readFile(tracePath, "utf8");
    const curlCalls = trace.split("\n").filter((line) => line.startsWith("curl "));
    assert.equal(curlCalls.length, 3);
    assert.match(curlCalls[0], /<http:\/\/127\.0\.0\.1:8787\/health>/u);
    assert.match(curlCalls[1], /<Origin: http:\/\/127\.0\.0\.1:5173>/u);
    assert.match(curlCalls[1], /<Sec-Fetch-Site: same-site>/u);
    assert.match(curlCalls[1], /<content-type: application\/json>/u);
    assert.match(curlCalls[2], /<Origin: http:\/\/127\.0\.0\.1:5173>/u);
    assert.match(curlCalls[2], /<Sec-Fetch-Site: same-site>/u);
    assert.match(curlCalls[2], /<@[^>]+>/u);
    assert.doesNotMatch(trace, new RegExp(sentinel, "u"));
    assert.doesNotMatch(trace, /LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD=/u);
    assert.match(result.stdout, /fresh bootstrap exposes only the real administrator/u);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(sentinel, "u"));
  } finally {
    await rm(fixtureDirectory, { force: true, recursive: true });
  }
});

test("redacts HTTP smoke request, response, and token material on login failure", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "laundry-http-smoke-failure-"));
  const smokeScript = fileURLToPath(new URL("tools/compose/smoke-test.sh", rootUrl));
  const sentinel = "SMOKE-ADMIN-PASSWORD-SENTINEL";

  try {
    const tracePath = await createHttpSmokeFakes(fixtureDirectory, sentinel);
    await assert.rejects(
      execFileAsync("/bin/bash", [smokeScript], {
        env: {
          ...process.env,
          PATH: `${fixtureDirectory}:${process.env.PATH ?? ""}`,
          TMPDIR: fixtureDirectory,
          FAKE_TRACE: tracePath,
          FAKE_CURL_FAIL_LOGIN: "1",
          LAUNDRY_LOCAL_ORG_CODE: "local",
          LAUNDRY_LOCAL_STORE_CODE: "main",
          LAUNDRY_BOOTSTRAP_ADMIN_USERNAME: "admin",
          ...httpSmokeSecretEnvironment(sentinel),
        },
      }),
      (error) => {
        assert.match(error.stderr, /administrator login failed/u);
        assert.doesNotMatch(`${error.stdout}\n${error.stderr}`, new RegExp(sentinel, "u"));
        assert.doesNotMatch(`${error.stdout}\n${error.stderr}`, /safe-access-token/u);
        return true;
      },
    );
  } finally {
    await rm(fixtureDirectory, { force: true, recursive: true });
  }
});
