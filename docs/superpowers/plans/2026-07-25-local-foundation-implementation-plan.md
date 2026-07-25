# Local Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the generic V2 local foundation: an explicit PostgreSQL/Fastify lifecycle, strict local authentication, one token-free React SPA shared by the browser and Electron, and a reproducible macOS `.app` smoke path.

**Architecture:** Keep Claude draft3.1a boundaries: PostgreSQL and Fastify run as independent local services, the browser talks to Fastify directly, and Electron loads the same built SPA through `app://local` while its main process owns credentials and HTTP. This plan stops at foundation readiness and login/shell smoke; money integrity, workday commands, counter UI completion, file printing, cloud and Windows remain later slices.

**Tech Stack:** Node.js 22+, pnpm 11, TypeScript strict, Zod 4, Fastify 5, PostgreSQL 16, Docker Compose, React 19, Vite 6, Electron 41, Node test runner, Vitest, Playwright.

---

## Scope and dependency order

Tasks run in order. Each task starts RED, reaches GREEN, and commits before the next task.

- Task 1: Current-route governance gate
- Task 2: Generic local profile and secret loading
- Task 3A: Explicit PostgreSQL bootstrap transaction
- Task 3B: Automatic seed removal and executable integration
- Task 4: Loopback Compose lifecycle
- Task 5: Strict access-token and session authority
- Task 6: Local HTTP security boundary
- Task 7: Token-free shared Web host ports
- Task 8: Pinned Electron installation boundary
- Task 9: Vite bundle and manifest-bound `app://`
- Task 10: Electron main-process desktop transport
- Task 11: macOS package and foundation acceptance

Do not implement pricing, payment/idempotency repair, business-day commands, the Claude
three-column UI, file-spool printing, cloud deployment, Windows packaging, AI, offline queue
or real hardware in this plan.

## File map

- `tests/foundation/workspace.test.mjs`: repository-route and Local Foundation invariants.
- `tests/foundation/local-foundation.test.mjs`: local runtime/Electron invariants added per task.
- `README.md`, `GEMINI.md`, `HERMES.md`: current ADR-14 entry points.
- `apps/server/src/local/profile.ts`: one generic local org/store/admin identity definition.
- `apps/server/src/local/config.ts`: validated runtime secrets, origins and authorities.
- `apps/server/src/local/bootstrap.ts`: idempotent, explicit PG bootstrap transaction.
- `apps/server/src/local/bootstrap-cli.ts`: non-HTTP bootstrap command boundary.
- `packages/db/src/migrations/0016_local_bootstrap.sql`: demo marker and bootstrap metadata.
- `tools/local/*.mjs`: repo-external config, Compose orchestration and guarded reset.
- `tools/compose/docker-compose.yml`: loopback-only local services with no embedded secrets.
- `apps/server/src/auth/*`: strict token/session resolution and server-side role projection.
- `apps/server/src/http/request-security.ts`: Host, Origin and forwarded-header gates.
- `apps/server/src/http/login-rate-limit.ts`: local multi-dimensional login throttling.
- `apps/web/src/host/*`: browser/desktop port selection with no token in React state.
- `apps/web/dist-spa/`: generated Vite artifact, never hand-edited or committed.
- `apps/edge-agent/scripts/sync-spa.mjs`: copy bundle and generate complete manifest.
- `apps/edge-agent/src/lib/integrity.ts`: verify every manifest entry before boot.
- `apps/edge-agent/src/protocol.ts`: serve only verified manifest keys.
- `packages/contracts/src/desktop/*`: Zod IPC operation schemas and token-free views.
- `apps/edge-agent/src/transport/*`: main-only auth state and fixed HTTP transport.
- `apps/edge-agent/src/preload.ts`, `src/ipc.ts`: four narrow renderer ports.
- `apps/edge-agent/electron-builder.yml`: generic unsigned macOS test package.
- `apps/edge-agent/e2e/local-mac.spec.ts`: Electron foundation smoke.

### Task 1: Lock the current generic local-first route

**Files:**

- Create: `tests/foundation/local-foundation.test.mjs`
- Modify: `README.md`
- Modify: `GEMINI.md`
- Modify: `HERMES.md`
- Modify: `package.json`

- [ ] **Step 1: Write the failing current-route test**

Add a focused ADR-14 test:

```js
const adr14Link = /\(docs\/adr\/2026-07-25-adr-14-generic-local-first-v2-delivery\.md\)/u;
for (const path of ["README.md", "AGENTS.md", "CLAUDE.md", "GROK.md", "GEMINI.md", "HERMES.md"]) {
  const contents = await readFile(new URL(path, rootUrl), "utf8");
  assert.match(contents, adr14Link, `${path} must link ADR-14`);
}
const readme = await readFile(new URL("README.md", rootUrl), "utf8");
assert.match(readme.slice(0, 1_500), /通用 V2.*本地 Web.*macOS/su);
assert.doesNotMatch(readme.slice(0, 1_500), /宏发升级候选版|Grok 单一技术负责人/u);
```

Change `workspace:test` to execute `node --test tests/foundation/*.test.mjs` so every later
Local Foundation invariant enters the default gate automatically.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test tests/foundation/local-foundation.test.mjs
```

Expected: FAIL because README/GEMINI/HERMES still route work to ADR-12/Grok/M2 Hongfa.

- [ ] **Step 3: Make the minimum documentation update**

The product design is already approved. Make each current entry point link ADR-14, identify
Codex as delivery owner, retain ADR-13 as the V2-only foundation, and describe this order
only:

```text
Local Foundation → Money Integrity → Workday Commands → Counter UI
→ Mock Print → Acceptance → later cloud/Windows
```

Keep historical plans and ADR bodies unchanged.

- [ ] **Step 4: Run GREEN checks**

Run:

```bash
node --test tests/foundation/*.test.mjs
pnpm exec prettier --check README.md GEMINI.md HERMES.md
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md GEMINI.md HERMES.md tests/foundation/local-foundation.test.mjs \
  package.json
git commit -m "[LAUNDRY_DESK][GOVERNANCE] 对齐通用 V2 本地优先路线"
```

### Task 2: Add one generic local profile and fail-closed secrets

**Files:**

- Create: `apps/server/src/local/profile.ts`
- Create: `apps/server/src/local/profile.test.ts`
- Create: `apps/server/src/local/config.ts`
- Create: `apps/server/src/local/config.test.ts`
- Modify: `apps/server/src/local/create-runtime.ts`
- Modify: `apps/server/src/local/demo-seed.ts`
- Modify: `apps/server/src/http/main.ts`
- Modify: `apps/web/host/main.tsx`
- Modify: `apps/web/src/auth/HttpAuthClient.ts`
- Modify: `package.json`
- Modify: `tests/foundation/local-foundation.test.mjs`

- [ ] **Step 1: Write failing profile/config tests**

Freeze a single non-secret profile:

```ts
export type LocalProfile = Readonly<{
  orgId: string;
  storeId: string;
  adminStaffId: string;
  orgCode: "local";
  storeCode: "main";
  orgName: "laundry-desk V2";
  storeName: "本地门店";
  timezone: string;
}>;
```

Tests must prove:

- UUIDs/codes/names have one source;
- timezone is a valid IANA name and defaults to `Asia/Taipei`;
- PG mode rejects a missing or shorter-than-32-byte signing secret;
- PG mode rejects missing, shorter-than-32-byte or identical access-token and CSRF proof
  secrets;
- allowed browser origin is exactly `http://127.0.0.1:5173`;
- host runtime defaults to `127.0.0.1:8787`;
- two memory test runtimes receive different random signing secrets;
- product entry files do not contain `Hongfa Laundry`, `hongfa`, `宏发`, `password=demo`
  or a printed PIN.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --filter @laundry/server build
node --test apps/server/dist/local/profile.test.js apps/server/dist/local/config.test.js
```

Expected: FAIL because the profile/config modules do not exist.

- [ ] **Step 3: Implement the minimum profile/config**

Use Zod to parse environment input. Production/local-PG code receives:

```ts
type LocalServerConfig = Readonly<{
  listenHost: "127.0.0.1" | "0.0.0.0";
  port: 8787;
  browserOrigin: "http://127.0.0.1:5173";
  hostAuthorities: readonly ["127.0.0.1:8787"];
  accessTokenSecret: string;
  csrfProofSecret: string;
}>;
```

`0.0.0.0` is allowed only when `LAUNDRY_CONTAINER_RUNTIME=1`; the Compose host mapping
remains loopback-only. Generate a random secret for memory unit runtimes instead of using a
source default. Remove credential output and product-specific login prefill/mapping. Rename
packaging display values to `laundry-desk V2`; do not alter frozen v1 source.

- [ ] **Step 4: Run GREEN checks**

Run:

```bash
pnpm --filter @laundry/server test
pnpm --filter @laundry/web test
pnpm --filter @laundry/server typecheck
pnpm --filter @laundry/web typecheck
```

Expected: PASS with no production-entry Hongfa/default-credential strings.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/local apps/server/src/http/main.ts apps/web/host/main.tsx \
  apps/web/src/auth/HttpAuthClient.ts tests/foundation/local-foundation.test.mjs \
  package.json
git commit -m "[LAUNDRY_DESK][LOCAL] 建立通用本地配置"
```

### Task 3A: Add the explicit PostgreSQL bootstrap transaction

**Files:**

- Create: `packages/db/src/migrations/0016_local_bootstrap.sql`
- Modify: `packages/db/src/schema/orgs.ts`
- Modify: `packages/db/src/migrations/README.md`
- Modify: `packages/db/test/migration-files.test.ts`
- Modify: `packages/db/test/destructive-migration.test.ts`
- Modify: `packages/db/test/schema-contract.test.ts`
- Create: `apps/server/src/local/bootstrap.ts`
- Create: `apps/server/src/local/bootstrap.test.ts`
- Create: `apps/server/src/local/bootstrap-cli.ts`
- Create: `apps/server/src/local/bootstrap-cli.test.ts`
- Modify: `apps/server/package.json`
- Modify: `package.json`

- [ ] **Step 1: Write failing bootstrap/migration tests**

`0016` is free on the current `main` baseline. Add a migration-list test that rejects
duplicate four-digit prefixes so the two unmerged candidate branches that also use `0016`
must be renumbered before future integration; do not reserve speculative gaps.

The migration adds `orgs.demo_only boolean NOT NULL DEFAULT false` plus this owner-only
singleton:

```sql
CREATE TABLE local_bootstrap_metadata (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  admin_staff_id uuid NOT NULL,
  profile_hash char(64) NOT NULL,
  demo_only boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON local_bootstrap_metadata FROM PUBLIC, laundry_app;
```

Tests cover:

- empty database creates exactly the configured org/store/admin and role;
- re-running identical input is a no-op;
- matching IDs/codes with different profile data or an existing non-matching bootstrap fail
  before any write;
- the transaction takes a fixed transaction-scoped PostgreSQL advisory lock before reading
  metadata, uses `SET LOCAL ROLE laundry_owner`, writes metadata last, commits once, and
  rolls back every partial failure;
- two concurrent identical bootstraps both succeed with one creation and one no-op; two
  different concurrent inputs serialize, then one fails with a safe conflict;
- password and PIN are required external inputs and only Argon2id hashes reach SQL;
- `profile_hash` is a stable SHA-256 over versioned non-secret profile/admin metadata only;
- demo mode requires loopback DB, `LAUNDRY_LOCAL_DEMO=1` and
  `--confirm laundry-desk-v2-demo`;
- non-demo requires `--confirm laundry-desk-v2-local`;
- non-demo preflight rejects `demo_only=true`;
- missing/unknown CLI inputs fail with safe error codes;
- stdout/stderr never contain password, PIN, PHC hash or database URL.

The command input is strict:

```ts
type BootstrapInput = Readonly<{
  profile: LocalProfile;
  adminUsername: string;
  adminDisplayName: string;
  adminPassword: string;
  adminPin: string;
  demoOnly: boolean;
}>;
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --filter @laundry/db test
pnpm --filter @laundry/server build
node --test apps/server/dist/local/bootstrap.test.js \
  apps/server/dist/local/bootstrap-cli.test.js
```

Expected: FAIL because migration `0016` and bootstrap code are absent.

- [ ] **Step 3: Implement one owner-only transaction and CLI**

Hash credentials before acquiring the transaction client. Inside one parameterized
transaction: acquire a documented fixed `pg_advisory_xact_lock`, set the owner role,
read/lock singleton metadata when it exists, verify the complete existing profile for an
idempotent no-op, perform collision preflight, insert org/store/admin/admin role, then insert
metadata last. Never use `ON CONFLICT DO UPDATE` for bootstrap identity.

The CLI accepts only `--confirm <exact-value>`, reads these values from the process
environment, and never exposes an HTTP route:

```text
LAUNDRY_BOOTSTRAP_ADMIN_USERNAME
LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME
LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD
LAUNDRY_BOOTSTRAP_ADMIN_PIN
DATABASE_ADMIN_URL
```

Add explicit `bootstrap:local`/`local:bootstrap` scripts. This task is additive; removal of
automatic runtime/Compose seed paths happens in Task 3B so every intermediate commit stays
green.

- [ ] **Step 4: Run GREEN checks**

Run:

```bash
pnpm --filter @laundry/db test
pnpm --filter @laundry/server test
pnpm --filter @laundry/server lint
pnpm --filter @laundry/server typecheck
```

Expected: tests PASS. Default server tests may still skip real PostgreSQL and are not runtime
evidence.

- [ ] **Step 5: Commit**

```bash
git add packages/db apps/server/src/local/bootstrap.ts \
  apps/server/src/local/bootstrap.test.ts apps/server/src/local/bootstrap-cli.ts \
  apps/server/src/local/bootstrap-cli.test.ts apps/server/package.json package.json
git commit -m "[LAUNDRY_DESK][DB] 增加显式本地初始化"
```

### Task 3B: Remove every automatic seed path and keep integration executable

**Files:**

- Modify: `apps/server/src/db/pg-pool.ts`
- Create: `apps/server/src/db/pg-pool.test.ts`
- Modify: `apps/server/src/local/create-runtime.ts`
- Modify: `apps/server/src/local/create-runtime.test.ts`
- Modify: `apps/server/src/local/bootstrap.ts`
- Modify: `apps/server/src/local/bootstrap.test.ts`
- Delete: `apps/server/src/local/pg-seed.ts`
- Delete: `apps/server/src/local/pg-seed.test.ts`
- Create: `apps/server/src/local/pg-test-fixture.ts`
- Create: `apps/server/src/local/pg-test-fixture.test.ts`
- Modify: `apps/server/src/identity/pg-store.test.ts`
- Modify: `apps/server/src/photo/pg-photo-store.test.ts`
- Modify: `apps/server/src/__tests__/rls-pg-integration.test.ts`
- Modify: `apps/server/src/__tests__/bus-pg-smoke.test.ts`
- Modify: `apps/server/src/catalog/pg-catalog-store.ts`
- Modify: `apps/server/src/catalog/pg-catalog-store.test.ts`
- Modify: `apps/server/src/http/create-app.test.ts`
- Delete: `tools/compose/seed-v2.mjs`
- Delete: `tools/compose/seed-v2.sh`
- Modify: `tools/compose/docker-compose.yml`
- Modify: `tools/compose/smoke-test.sh`
- Modify: `tools/compose/README.md`
- Modify: `.github/workflows/v2-integration.yml`
- Modify: `apps/web/e2e/local-login.spec.ts`
- Modify: `tests/foundation/local-foundation.test.mjs`

- [ ] **Step 1: Write failing runtime/catalog/integration tests**

Tests prove:

- the PG runtime accepts only an app-role URL, opens one app pool, verifies the fixed profile,
  and closes the pool on readiness failure;
- an admin-only URL can never fall back into the runtime app connection;
- `createPgLocalRuntime` never imports/calls a seed or creates an admin pool;
- an empty catalog returns `[]` and executes no `INSERT`;
- the test-only PG fixture is imported only by `*.test.ts` and receives credentials from the
  ephemeral test environment; its unit test rejects missing values and proves no source
  default credential reaches SQL;
- no HTTP route exposes bootstrap or reset;
- Compose has no default seed service and server does not depend on one;
- CI generates ephemeral bootstrap/access/CSRF values, runs migration and bootstrap
  explicitly, repeats both to prove idempotency, then starts the server;
- server smoke and browser E2E read the same generic `local/main` username/password from
  environment and contain no fixed demo credential or Hongfa assertion.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --filter @laundry/server build
node --test apps/server/dist/db/pg-pool.test.js \
  apps/server/dist/local/create-runtime.test.js \
  apps/server/dist/local/pg-test-fixture.test.js \
  apps/server/dist/catalog/pg-catalog-store.test.js
node --test tests/foundation/local-foundation.test.mjs
```

Expected: FAIL because runtime and Compose still seed automatically, admin URL fallback
exists, and catalog reads write demo rows.

- [ ] **Step 3: Remove seed paths and wire explicit integration bootstrap**

Keep `resolvePgUrls` only for opt-in PG tests that need app and admin connections; add a
fail-closed runtime resolver that never falls back to admin. `createPgLocalRuntime` opens
only the app pool and calls an app-role readiness check from `bootstrap.ts`.

Replace production `pg-seed.ts` with a test-only fixture used by the four real-PG tests.
The helper may create extra fictional staff for tests, but no production module may import
it. Remove catalog write-on-read.

Compose keeps its current local credential topology only until Task 4, but bootstrap becomes
an explicit profile/service and is never a default dependency. The integration workflow
must start PG/migrations, invoke bootstrap with generated ephemeral inputs, then start
Fastify. Update HTTP/Web smoke to fill the generic login form from that same environment.
Foundation E2E only needs admin login/shell; do not depend on an automatically created
second staff member. Remove the fixed Compose `container_name` so tests can use an isolated
project/volume and clean up only what they created.

- [ ] **Step 4: Run GREEN and integration checks**

Run:

```bash
pnpm --filter @laundry/server test
pnpm --filter @laundry/web test
node --test tests/foundation/*.test.mjs
LAUNDRY_ACCESS_TOKEN_SECRET="$(openssl rand -hex 32)" \
LAUNDRY_CSRF_PROOF_SECRET="$(openssl rand -hex 32)" \
LAUNDRY_BOOTSTRAP_ADMIN_USERNAME=admin \
LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME="Local Administrator" \
LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD="${LAUNDRY_TEST_ADMIN_PASSWORD:?set test password}" \
LAUNDRY_BOOTSTRAP_ADMIN_PIN="${LAUNDRY_TEST_ADMIN_PIN:?set test PIN}" \
  docker compose -f tools/compose/docker-compose.yml config --quiet
```

Expected: tests and Compose config PASS; `rg` returns no production/Compose/CI seed path.
Run this reproducible real-PostgreSQL sequence when Docker is available:

```bash
set -euo pipefail
export COMPOSE_PROJECT_NAME="laundry-task3b-${PPID}"
export LAUNDRY_ACCESS_TOKEN_SECRET="$(openssl rand -hex 32)"
export LAUNDRY_CSRF_PROOF_SECRET="$(openssl rand -hex 32)"
export LAUNDRY_BOOTSTRAP_ADMIN_USERNAME=admin
export LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME="Local Administrator"
export LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD="$(openssl rand -base64 36 | tr -d '\n')"
export LAUNDRY_BOOTSTRAP_ADMIN_PIN="$(
  node -e 'console.log(require("node:crypto").randomInt(100000,1000000))'
)"
compose_file="tools/compose/docker-compose.yml"
web_pid=""
cleanup() {
  if [ -n "${web_pid}" ]; then kill "${web_pid}" 2>/dev/null || true; fi
  docker compose -f "${compose_file}" down --volumes --remove-orphans || true
}
trap cleanup EXIT

docker compose -f "${compose_file}" up -d --build postgres
docker compose -f "${compose_file}" run --rm migrate
docker compose -f "${compose_file}" run --rm migrate
docker compose -f "${compose_file}" run --rm bootstrap
docker compose -f "${compose_file}" run --rm bootstrap
docker compose -f "${compose_file}" up -d server
bash tools/compose/smoke-rls.sh
bash tools/compose/smoke-test.sh
set -o pipefail
LAUNDRY_USE_LOCAL_PG=1 pnpm --filter @laundry/server test |
  tee /tmp/laundry-task3b-pg-tests.log
! rg -q '^# skipped [1-9][0-9]*$' /tmp/laundry-task3b-pg-tests.log
pnpm local:web >/tmp/laundry-task3b-web.log 2>&1 &
web_pid=$!
for _ in $(seq 1 30); do
  curl --fail --silent http://127.0.0.1:5173/ >/dev/null && break
  kill -0 "${web_pid}" 2>/dev/null || {
    cat /tmp/laundry-task3b-web.log
    exit 1
  }
  sleep 1
done
curl --fail http://127.0.0.1:5173/ >/dev/null
pnpm local:web:e2e
```

The trap removes only the unique Task 3B Compose project and volume. If Docker Desktop is
unavailable or either fixed port is already occupied, report that external evidence as
blocked instead of stopping an unrelated process or substituting memory tests.

Check removal with an explicit negative assertion:

```bash
if rg -n "seedDemoIdentity|seed-v2" apps/server/src tools/compose .github/workflows; then
  echo "automatic seed path remains" >&2
  exit 1
fi
```

- [ ] **Step 5: Commit**

```bash
git add apps/server/src apps/web/e2e/local-login.spec.ts tools/compose \
  .github/workflows/v2-integration.yml tests/foundation/local-foundation.test.mjs
git commit -m "[LAUNDRY_DESK][DB] 移除自动初始化路径"
```

### Task 4: Add safe `local:up`, `local:down` and guarded reset

**Files:**

- Create: `tools/local/config.mjs`
- Create: `tools/local/config.test.mjs`
- Create: `tools/local/compose.mjs`
- Create: `tools/local/compose.test.mjs`
- Create: `tools/local/up.mjs`
- Create: `tools/local/down.mjs`
- Create: `tools/local/reset.mjs`
- Modify: `tools/compose/docker-compose.yml`
- Create: `tools/compose/bootstrap-roles.sh`
- Delete: `tools/compose/bootstrap.sql`
- Modify: `tools/compose/migrate-v2.sh`
- Modify: `tools/compose/smoke-rls.sh`
- Modify: `tools/compose/smoke-test.sh`
- Modify: `tools/compose/README.md`
- Modify: `docs/local-web-server.md`
- Modify: `.github/workflows/v2-integration.yml`
- Modify: `package.json`

- [ ] **Step 1: Write failing lifecycle tests**

Parse the Compose YAML as text plus test pure command builders. Require:

```yaml
ports:
  - "127.0.0.1:8543:5432"
  - "127.0.0.1:8787:8787"
```

Assert there is no automatic `seed` service, no source credential, no `down -v` in normal
shutdown, and no unresolved user-controlled shell interpolation. Repo-external config must
be created under the OS application-support directory with directory mode `0700` and file
mode `0600`. Generated PG/app/access-token/CSRF secrets are independent and at least 32
random bytes.

`bootstrap-roles.sh` is the only initdb role script. It passes the externally generated app
password to `psql` as a variable and uses PostgreSQL quoting; it never interpolates a shell
value into SQL text.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --test tools/local/config.test.mjs tools/local/compose.test.mjs
```

Expected: FAIL because the lifecycle modules do not exist and Compose publishes all
interfaces with fixed passwords.

- [ ] **Step 3: Implement the minimum orchestration**

`pnpm local:up` must:

1. validate Docker Compose and repo-external config;
2. start PG and wait for health;
3. run checksum-guarded migrations;
4. run bootstrap only with explicit `--bootstrap` plus required admin env;
5. run schema/profile preflight;
6. start Fastify and wait for minimal `/health`.

`pnpm local:down` runs Compose down without `--volumes`. `pnpm local:reset` only removes
the named `pgdata-v2` volume when passed `--confirm DELETE-laundry-desk-v2-local`; print the
exact target before deletion.

An explicit first bootstrap reads these environment variables:

```text
LAUNDRY_BOOTSTRAP_ADMIN_USERNAME
LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME
LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD
LAUNDRY_BOOTSTRAP_ADMIN_PIN
```

All four are required with `--bootstrap`; password/PIN are never written to repo config or
logs. CI and local automation provide them through an ephemeral process environment.

Update the integration workflow to generate ephemeral CI secrets and call the explicit demo
bootstrap. It must not recover the old automatic seed topology.

- [ ] **Step 4: Run GREEN and real runtime checks**

Run:

```bash
node --test tools/local/config.test.mjs tools/local/compose.test.mjs
LAUNDRY_BOOTSTRAP_ADMIN_USERNAME=admin \
LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME="Local Administrator" \
LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD="${LAUNDRY_TEST_ADMIN_PASSWORD:?set test password}" \
LAUNDRY_BOOTSTRAP_ADMIN_PIN="${LAUNDRY_TEST_ADMIN_PIN:?set test PIN}" \
  pnpm local:up -- --bootstrap
bash tools/compose/smoke-rls.sh
curl --fail http://127.0.0.1:8787/health
pnpm local:down
docker volume inspect laundry-desk_pgdata-v2
```

Expected: unit tests and smokes PASS; shutdown preserves the volume. If Docker Desktop is
not running, report this step as blocked external evidence rather than substituting memory
runtime.

- [ ] **Step 5: Commit**

```bash
git add tools/local tools/compose docs/local-web-server.md \
  .github/workflows/v2-integration.yml package.json
git commit -m "[LAUNDRY_DESK][LOCAL] 固化本地服务生命周期"
```

### Task 5: Enforce strict access-token and server-side session authority

**Files:**

- Modify: `packages/contracts/src/auth/session.ts`
- Modify: `packages/contracts/test/auth-session.test.ts`
- Modify: `packages/contracts/src/auth/operations.ts`
- Modify: `packages/contracts/test/auth-operations.test.ts`
- Modify: `packages/contracts/test/envelope-types.test.ts`
- Modify: `packages/contracts/test/consumers.test.ts`
- Modify: `apps/server/src/identity/crypto-util.ts`
- Modify: `apps/server/src/identity/identity.test.ts`
- Modify: `apps/server/src/auth/resolve-session.ts`
- Modify: `apps/server/src/auth/auth.test.ts`
- Create: `apps/server/src/auth/session-view.ts`
- Create: `apps/server/src/auth/session-view.test.ts`
- Modify: `apps/server/src/http/create-app.ts`
- Modify: `apps/server/src/http/pin-routes.ts`
- Modify: `apps/web/src/auth/types.ts`
- Modify: `apps/web/src/auth/HttpAuthClient.ts`
- Modify: `apps/web/src/auth/http-auth-client.test.ts`

- [ ] **Step 1: Write failing token/session tests**

Freeze claims:

```ts
type AccessTokenClaims = Readonly<{
  iss: "laundry-desk-v2-local";
  aud: "laundry-desk-v2-api";
  session_id: string;
  session_version: number;
  org_id: string;
  store_id: string;
  staff_id: string;
  device_id: string;
  permission_version: number;
  authentication_method: "password" | "pin" | "refresh";
  iat: number;
  exp: number;
}>;
```

Tests reject wrong/missing `alg`, `typ`, issuer, audience, exact 900-second TTL, future
`iat`, expired tokens, revoked/version/tenant/staff/device/permission mismatch and tenant
authority headers. Session view and permissions must come from server repositories, never
staff-ID suffixes or client code maps. Extend `AccessSessionResponseSchema` itself with the
strict, token-adjacent projection already consumed by the Web client:

```ts
role: "admin" | "staff";
features: Readonly<Record<string, boolean>>;
display: Readonly<{
  store_name: string;
  staff_name: string;
  org_code: string;
  store_code: string;
}>;
```

Contract and Web consumer tests reject a missing projection, unknown fields and any fallback
that derives role/features/display from a staff ID or hard-coded client map. Update the
existing envelope and consumer response fixtures to include the same projection.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --filter @laundry/contracts test -- auth-session
pnpm --filter @laundry/server build
node --test apps/server/dist/auth/auth.test.js apps/server/dist/auth/session-view.test.js
```

Expected: FAIL on issuer/audience/header checks and absent session-view projection.

- [ ] **Step 3: Implement and wire the existing strict resolver**

Make `createAccessTokenSigner` accept validated issuer/audience/secret configuration and
verify the exact protected header before claims. Replace `create-app.ts`'s private weak
resolver and staff-ID role heuristic with `resolveSessionFromBearer` plus a server-side
role/display/features lookup. Login, refresh and quick-switch PIN responses are parsed by
the updated `AccessSessionResponseSchema` and return the same server-owned projection
alongside the access payload; no client mapping creates authority.

- [ ] **Step 4: Run GREEN checks**

Run:

```bash
pnpm --filter @laundry/contracts test
pnpm --filter @laundry/server test
pnpm --filter @laundry/web test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/auth/session.ts packages/contracts/test/auth-session.test.ts \
  packages/contracts/src/auth/operations.ts packages/contracts/test/auth-operations.test.ts \
  packages/contracts/test/envelope-types.test.ts packages/contracts/test/consumers.test.ts \
  apps/server/src/auth apps/server/src/identity apps/server/src/http \
  apps/web/src/auth
git commit -m "[LAUNDRY_DESK][AUTH] 接入严格会话解析"
```

### Task 6: Close the localhost HTTP security boundary

**Files:**

- Create: `apps/server/src/http/request-security.ts`
- Create: `apps/server/src/http/request-security.test.ts`
- Create: `apps/server/src/http/login-rate-limit.ts`
- Create: `apps/server/src/http/login-rate-limit.test.ts`
- Modify: `apps/server/src/http/create-app.ts`
- Modify: `apps/server/src/http/create-app.test.ts`
- Modify: `apps/server/src/http/cookie-policy.ts`
- Modify: `apps/server/src/http/cookie-policy.test.ts`
- Modify: `apps/server/src/http/main.ts`
- Modify: `apps/server/src/auth/csrf.ts`
- Modify: `apps/server/src/auth/auth.test.ts`
- Modify: `apps/server/src/identity/session.ts`
- Modify: `apps/server/src/identity/identity.test.ts`

- [ ] **Step 1: Write failing HTTP negative tests**

Cover:

- exact allowed Host and rejection of unknown Host/DNS rebinding;
- rejection of any `Forwarded`, `X-Forwarded-Host` or `X-Forwarded-Proto`;
- exact browser `Origin: http://127.0.0.1:5173` and desktop
  `Origin: app://local`; reject missing/`null`/localhost/other origins where required;
- browser state-changing requests require `Sec-Fetch-Site: same-site`; Electron main
  requests require the explicitly constructed `Sec-Fetch-Site: none`; reject missing,
  cross-site and origin/fetch-site combinations from the wrong host;
- no wildcard/reflected CORS;
- JSON-only state changes and CSRF on refresh/logout/command/PIN;
- the CSRF proof is HMAC-bound to `session_id`, `session_version` and a random rotation
  nonce; a syntactically valid proof from another session/version fails, and login,
  refresh and quick-switch rotation invalidate the previous proof;
- unauthenticated `/api/v2/local/staff` rejected;
- `/health` returns only `{ok:true,data:{status:"ready"}}`;
- login throttles by normalized org/store/username and IP; PIN retains its
  session/store/staff lockout;
- public errors omit stack, SQL, path, token and account-existence details;
- logs redact `authorization`, cookies, CSRF, password, PIN and token fields.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --filter @laundry/server build
node --test apps/server/dist/http/request-security.test.js \
  apps/server/dist/http/login-rate-limit.test.js \
  apps/server/dist/http/create-app.test.js
```

Expected: FAIL because current app trusts broad localhost defaults and exposes staff
anonymously.

- [ ] **Step 3: Implement focused Fastify hooks**

Keep `create-app.ts` below 800 lines by installing small hooks from
`request-security.ts`. Instantiate Fastify with `trustProxy:false` and structured logger
redaction. Do not treat loopback as authentication. Apply exact origin independently of
CORS to cookie-auth lifecycle requests.

Use the independent `csrfProofSecret` from Task 2 to mint and verify an opaque
`v1.<base64url(compact-binary-payload || mac)>` proof that remains within the frozen
43–128-character contracts bound. The compact payload contains a UUID-sized session
identifier, integer session version and random nonce. For bearer requests, validate it
against the resolved active session; for refresh/logout, first resolve the opaque refresh
cookie to its server-side session binding, then validate the proof before mutation. Never
trust a session identifier from the request body. Rotate the proof on login, refresh and
quick switch, and use constant-time MAC comparison.

- [ ] **Step 4: Run GREEN checks**

Run:

```bash
pnpm --filter @laundry/server test
pnpm --filter @laundry/server lint
pnpm --filter @laundry/server typecheck
```

Expected: PASS with all negative cases.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/http apps/server/src/auth/csrf.ts \
  apps/server/src/auth/auth.test.ts apps/server/src/identity/session.ts \
  apps/server/src/identity/identity.test.ts
git commit -m "[LAUNDRY_DESK][HTTP] 收紧本地服务边界"
```

### Task 7: Remove tokens from React state and introduce shared host ports

**Files:**

- Create: `apps/web/src/host/types.ts`
- Create: `apps/web/src/host/browser-ports.ts`
- Create: `apps/web/src/host/browser-ports.test.ts`
- Create: `apps/web/src/host/desktop-ports.ts`
- Create: `apps/web/src/host/desktop-ports.test.ts`
- Create: `apps/web/src/host/ServiceGate.tsx`
- Create: `apps/web/src/host/service-gate.test.ts`
- Modify: `apps/web/src/auth/types.ts`
- Modify: `apps/web/src/auth/AuthClient.ts`
- Modify: `apps/web/src/auth/HttpAuthClient.ts`
- Modify: `apps/web/src/commands/command-client.ts`
- Modify: `apps/web/src/commands/query-client.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/shell/CounterShell.tsx`
- Modify: `apps/web/host/main.tsx`
- Modify: related `apps/web/src/**/*.test.ts`

- [ ] **Step 1: Write failing host-port/token tests**

React-visible session becomes:

```ts
type SessionView = Readonly<{
  session: BrowserSessionView;
  role: StaffRole;
  features: Readonly<Record<string, boolean>>;
  display: Readonly<{
    store_name: string;
    staff_name: string;
    org_code: string;
    store_code: string;
  }>;
}>;

type AppPorts = Readonly<{
  auth: AuthPort;
  command: CommandPort;
  query: QueryPort;
  health: HealthPort;
}>;
```

Assert rendered props, React state, desktop bridge responses and Web Storage never contain
`access_token`, refresh token, cookie or header. Browser ports keep access/CSRF in one
closure and attach them internally. Desktop ports forward only named operations and parsed
business inputs.

Also test the startup gate: a pending health check shows loading, an unreachable service
shows a local-service diagnostic instead of Login/CounterShell, and its retry button calls
`HealthPort.get()` again and enters Login only after a healthy result.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --filter @laundry/web build
node --test apps/web/dist/host/browser-ports.test.js \
  apps/web/dist/host/desktop-ports.test.js \
  apps/web/dist/host/service-gate.test.js
```

Expected: FAIL because `AccessSession` currently carries `access_token` into React and
CounterShell creates clients from it.

- [ ] **Step 3: Implement the minimum host adapter**

`App` receives `AppPorts`; `CounterShell` receives command/query ports directly. Browser
host uses the existing HTTP clients behind a private credential closure. Desktop host uses
only the narrow `window.laundryDesktop` bridge. Import both UI CSS entry points plus focused
shell CSS from the single host entry. Wrap the app in `ServiceGate`; do not render Login or
CounterShell before a successful health response.

- [ ] **Step 4: Run GREEN checks**

Run:

```bash
pnpm --filter @laundry/web test
pnpm --filter @laundry/web lint
pnpm --filter @laundry/web typecheck
```

Expected: PASS, including an explicit `JSON.stringify(sessionView)` token absence check.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "[LAUNDRY_DESK][WEB] 建立无令牌共享宿主端口"
```

### Task 8: Pin and explicitly install Electron

**Files:**

- Modify: `package.json`
- Modify: `apps/edge-agent/package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`
- Modify: `tests/foundation/local-foundation.test.mjs`

- [ ] **Step 1: Write the failing installation-boundary test**

Assert both manifests use the exact Electron version already resolved by the lockfile,
`pnpm-workspace.yaml` allows only the Electron package pinned by those manifests,
`@google/genai` remains blocked, and root install no longer runs a broad native rebuild as
an implicit postinstall.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test tests/foundation/local-foundation.test.mjs
pnpm --filter @laundry/edge-agent exec electron --version
```

Expected: the static test fails on caret ranges/blocked Electron, and the executable reports
that Electron was not installed correctly.

- [ ] **Step 3: Apply the minimum reviewed allowlist**

Pin both manifests to the lockfile's existing Electron resolution. Change only
`electron: false` to `electron: true`; keep unrelated lifecycle scripts blocked. Remove the
root's broad automatic native-rebuild postinstall and expose any still-needed legacy rebuild
as an explicit command. Run `pnpm install --lockfile-only` once to update importer
specifiers without selecting a new resolution.

- [ ] **Step 4: Run GREEN checks**

Run:

```bash
pnpm install --lockfile-only
pnpm install --frozen-lockfile
pnpm rebuild electron
node --test tests/foundation/local-foundation.test.mjs
pnpm --filter @laundry/edge-agent exec electron --version
git diff -- pnpm-lock.yaml
```

Expected: tests PASS, Electron prints the pinned version, and the lockfile has no new
resolution or unrelated importer drift.

- [ ] **Step 5: Commit**

```bash
git add package.json apps/edge-agent/package.json pnpm-workspace.yaml pnpm-lock.yaml \
  tests/foundation/local-foundation.test.mjs
git commit -m "[LAUNDRY_DESK][ELECTRON] 固定本地运行版本"
```

### Task 9: Build the real SPA and bind `app://` to a complete manifest

**Files:**

- Modify: `apps/web/vite.config.ts`
- Modify: `apps/web/package.json`
- Modify: `apps/web/index.html`
- Modify: `apps/web/playwright.local.config.ts`
- Modify: `apps/edge-agent/package.json`
- Create: `apps/edge-agent/scripts/sync-spa.mjs`
- Create: `apps/edge-agent/scripts/sync-spa.test.mjs`
- Modify: `apps/edge-agent/src/lib/integrity.ts`
- Modify: `apps/edge-agent/src/lib/integrity.test.ts`
- Modify: `apps/edge-agent/src/protocol.ts`
- Modify: `apps/edge-agent/src/protocol.test.ts`
- Modify: `apps/edge-agent/src/main.ts`
- Delete: `apps/edge-agent/resources/spa/app.js`
- Modify: `apps/edge-agent/resources/spa/index.html`
- Modify: `apps/edge-agent/resources/spa/manifest.json`
- Modify: `turbo.json`

- [ ] **Step 1: Write failing bundle/manifest tests**

The manifest shape is:

```ts
type SpaManifest = Readonly<{
  version: 1;
  entries: Readonly<Record<string, Readonly<{ sha256: string; mime: string; bytes: number }>>>;
}>;
```

Tests prove every Vite output file except `manifest.json` is listed, path keys are normalized,
hash/MIME/size match, and any changed, missing, extra, symlinked or unknown-MIME asset fails.
The protocol serves only manifest keys and returns CSP:

```text
default-src 'self'; script-src 'self'; object-src 'none';
base-uri 'none'; frame-ancestors 'none'; connect-src 'none'
```

No `unsafe-inline`, `unsafe-eval`, arbitrary filesystem fallback or placeholder page.
The pure handler remains session-agnostic; registration moves to the dedicated Electron
session in Task 10.

Keep the generic environment-driven login E2E established in Task 3B. It must continue to
assert that the login form is not prefilled and fail before navigation when required test
credentials are absent.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --filter @laundry/web build
node --test apps/edge-agent/scripts/sync-spa.test.mjs
pnpm --filter @laundry/edge-agent test
```

Expected: FAIL because Web has no deployable `dist-spa` and integrity covers only
`index.html`.

- [ ] **Step 3: Implement deterministic SPA sync**

Vite writes `apps/web/dist-spa` with relative asset URLs. The sync script uses a temporary
directory, copies the complete bundle, generates sorted manifest entries, verifies them,
then atomically replaces `resources/spa`. Do not hand-maintain generated assets.

Add explicit Edge scripts `spa:sync` and `spa:check`. Packaging must call `spa:sync`;
`spa:check` is only a verification step and never repairs stale output.

Configure Playwright's `webServer` to start the Vite host on `127.0.0.1:5173`, wait for its
URL, and stop the process after tests. `pnpm local:web:e2e` must therefore require Fastify
from `local:up` but must not require a manually managed second terminal.

- [ ] **Step 4: Run GREEN checks**

Run:

```bash
pnpm --filter @laundry/web build
pnpm --filter @laundry/edge-agent spa:sync
pnpm --filter @laundry/edge-agent build
pnpm --filter @laundry/edge-agent test
pnpm --filter @laundry/edge-agent spa:check
```

Expected: PASS and `resources/spa/index.html` references hashed Vite assets from the real
Web app.

- [ ] **Step 5: Commit**

```bash
git add apps/web apps/edge-agent turbo.json
git commit -m "[LAUNDRY_DESK][ELECTRON] 复用真实 Web 构建产物"
```

### Task 10: Implement the main-only Electron desktop transport

**Files:**

- Create: `packages/contracts/src/desktop/operations.ts`
- Create: `packages/contracts/test/desktop-operations.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/edge-agent/src/transport/auth-state.ts`
- Create: `apps/edge-agent/src/transport/auth-state.test.ts`
- Create: `apps/edge-agent/src/transport/http-client.ts`
- Create: `apps/edge-agent/src/transport/http-client.test.ts`
- Create: `apps/edge-agent/src/transport/handlers.ts`
- Create: `apps/edge-agent/src/transport/handlers.test.ts`
- Modify: `apps/edge-agent/src/lib/security-prefs.ts`
- Modify: `apps/edge-agent/src/lib/sender.ts`
- Modify: `apps/edge-agent/src/lib/sender.test.ts`
- Modify: `apps/edge-agent/src/preload.ts`
- Modify: `apps/edge-agent/src/ipc.ts`
- Modify: `apps/edge-agent/src/main.ts`
- Modify: `apps/edge-agent/src/window.ts`

- [ ] **Step 1: Write failing desktop transport tests**

Expose exactly four namespaces:

```ts
window.laundryDesktop = {
  auth: { login, refresh, pinChallenge, pinVerify, logout },
  command: { execute },
  query: { execute },
  health: { get },
};
```

Each argument/result uses a Zod schema. Tests prove:

- renderer cannot pass URL, method, headers, Origin or cookies;
- command/query names must exist in contracts registries;
- `DesktopAuthState` alone holds the access token and token-free `SessionView`;
- login/refresh/PIN atomically replace auth state; logout clears state and partition cookies;
- cookie-auth requests always use the dedicated Electron session,
  `credentials:"include"`, `redirect:"error"`, fixed `Origin: app://local` and fixed
  `Sec-Fetch-Site: none`;
- child frames, foreign `webContents`, `app://evil`, non-main frame and non-normalized sender
  URLs fail;
- network failures return the common actionable envelope and are never swallowed.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --filter @laundry/contracts test -- desktop-operations
pnpm --filter @laundry/edge-agent build
node --test apps/edge-agent/dist/transport/auth-state.test.js \
  apps/edge-agent/dist/transport/http-client.test.js \
  apps/edge-agent/dist/transport/handlers.test.js
```

Expected: FAIL because the transport and schemas do not exist.

- [ ] **Step 3: Implement the minimum main-process transport**

Create `session.fromPartition("persist:laundry-v2-local")` in main and inject it into a
fixed-base HTTP adapter using Electron `net.request`. Register the custom protocol and
permission-deny handler on this same session, not `protocol`/`defaultSession`. The main
process reads the CSRF cookie from that session and constructs every request. Preload
exposes no generic invoke/fetch. The adapter, not renderer input, sets
`Sec-Fetch-Site: none`. Keep legacy pairing/offline/hardware IPC out of the renderer bridge
for this Local Foundation build.

- [ ] **Step 4: Run GREEN and security checks**

Run:

```bash
pnpm --filter @laundry/contracts test
pnpm --filter @laundry/edge-agent test
pnpm --filter @laundry/edge-agent lint
pnpm --filter @laundry/edge-agent typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts apps/edge-agent
git commit -m "[LAUNDRY_DESK][ELECTRON] 增加主进程认证传输"
```

### Task 11: Produce and smoke-test the generic macOS `.app`

**Files:**

- Create: `apps/edge-agent/electron-builder.yml`
- Create: `apps/edge-agent/e2e/local-mac.spec.ts`
- Create: `apps/edge-agent/playwright.electron.config.ts`
- Create: `apps/edge-agent/scripts/hash-app.mjs`
- Create: `apps/edge-agent/scripts/hash-app.test.mjs`
- Modify: `apps/edge-agent/package.json`
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `docs/CHANGELOG.md`
- Create: `tools/local/acceptance.mjs`
- Create: `tools/local/acceptance.test.mjs`

- [ ] **Step 1: Write failing packaging/smoke tests**

Static tests require:

- generic `appId`/`productName`, no Hongfa name;
- packaged files include `dist/**` and the verified SPA, but not source, `.env`, logs or
  credentials;
- Electron security preferences remain all enabled;
- app tree hash is deterministic for identical file bytes/path/mode;
- mac smoke sees a service-unavailable diagnostic when Fastify is down, then login shell
  when local-PG is up;
- renderer evaluation cannot find token/cookie/header values or generic bridge functions.
- the acceptance harness refuses occupied fixed ports, uses a unique Compose project and
  external temporary config, passes one credential set to bootstrap/browser/macOS, and
  always cleans its own processes, containers, volume and config in `finally`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --test tools/local/acceptance.test.mjs
node --test apps/edge-agent/scripts/hash-app.test.mjs
pnpm --filter @laundry/edge-agent test
pnpm local:mac:build
```

Expected: FAIL because Edge has no macOS packaging target.

- [ ] **Step 3: Add the minimum unsigned local package**

Package the already pinned Electron runtime to
`apps/edge-agent/release/mac-*/laundry-desk V2.app`; do not add signing, notarization, DMG,
update or Windows targets. Record the deterministic app-tree hash as test evidence, not
release-grade tamper proof.

Add `pnpm local:acceptance` as the single deterministic harness. It must:

1. require all four `LAUNDRY_BOOTSTRAP_ADMIN_*` values and reject an already occupied
   `127.0.0.1:8543` or `127.0.0.1:8787`;
2. create a unique `COMPOSE_PROJECT_NAME` plus temporary external config directory;
3. run `local:up --bootstrap`, wait for PG/API health, and run browser E2E with those same
   credentials;
4. build/sync the SPA and package the macOS app;
5. run normal `local:down`, wait until `/health` is unreachable, and verify its isolated
   PG volume still exists;
6. launch the packaged app, assert the unavailable state, run `local:up` without bootstrap,
   wait for `/health`, click Retry, and log in with the same identity;
7. in `finally`, close Electron, run normal down, then remove only the validated
   acceptance-project volume and temporary config.

`local-mac.spec.ts` owns step 6's stop/start/retry assertions and receives the exact
project/config environment from the harness. Every health wait has a bounded timeout and
diagnostic on failure.

- [ ] **Step 4: Run complete Local Foundation acceptance**

Run:

```bash
pnpm install --frozen-lockfile
pnpm rebuild electron
pnpm workspace:check
LAUNDRY_BOOTSTRAP_ADMIN_USERNAME=admin \
LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME="Local Administrator" \
LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD="${LAUNDRY_TEST_ADMIN_PASSWORD:?set test password}" \
LAUNDRY_BOOTSTRAP_ADMIN_PIN="${LAUNDRY_TEST_ADMIN_PIN:?set test PIN}" \
  pnpm local:acceptance
git diff --check
git status --short
```

Expected:

- all format/lint/type/test/build checks pass;
- browser and macOS app use the same real SPA and local-PG identity;
- macOS app fails honestly when service is down and recovers after retry;
- normal shutdown preserves the isolated volume before the harness removes that exact test
  volume during final cleanup;
- generated build/coverage artifacts are ignored and the worktree contains only intended
  source/doc changes.

Dispatch `security-reviewer` for the complete Local Foundation diff. Fix all Critical/High
findings and re-run the relevant negative tests before commit.

- [ ] **Step 5: Commit**

```bash
git add apps/edge-agent tools/local/acceptance.mjs tools/local/acceptance.test.mjs \
  package.json .gitignore docs/CHANGELOG.md
git commit -m "[LAUNDRY_DESK][MACOS] 交付本地测试应用"
```

## Completion boundary

Local Foundation is complete only after Task 11 automated evidence and an actual local
browser/macOS smoke both pass against PostgreSQL. A green unit suite alone is not runtime
evidence; a generated `.app` alone is not login evidence; an unsigned hash is not release
integrity. After this plan, start a separate Money Integrity plan from the approved product
design.
