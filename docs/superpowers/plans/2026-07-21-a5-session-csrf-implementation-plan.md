# A5 Session, Refresh, CSRF and PIN Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze executable contract-only semantics for browser sessions, refresh rotation/reuse, CSRF, PIN quick-switch/step-up and identity lifecycle operations without implementing C6 persistence or cryptography.

**Architecture:** Add focused `auth/*` modules with strict Zod schemas, immutable outputs, runtime provenance guards and pure state decisions. Patch A2 so normal command envelopes consume a provenance-checked browser/Edge source union, while ADR-11 lifecycle operations use a narrow pre-auth envelope and the same public error envelope.

**Tech Stack:** TypeScript strict, Zod 4, Vitest 3, existing `@laundry/contracts` patterns, pnpm/Turborepo.

---

## File map

- `packages/contracts/src/auth/plain-data.ts`: descriptor-based exact plain-data snapshots shared by auth factories.
- `packages/contracts/src/auth/session.ts`: access/session shapes, active/version check and public source guards.
- `packages/contracts/src/auth/source-registry.ts`: package-internal browser/Edge provenance registries.
- `packages/contracts/src/auth/browser-ingress.ts`: browser authority factory, exported only as a server-internal subpath.
- `packages/contracts/src/auth/edge-ingress.ts`: Edge authority factory, exported only as a separate server-internal subpath.
- `packages/contracts/src/auth/refresh.ts`: TTL/cookie descriptors, refresh state/reuse/logout decisions and clear-cookie descriptors.
- `packages/contracts/src/auth/csrf.ts`: CSRF proof/request schema, safe-method classification and non-leaking decision.
- `packages/contracts/src/auth/pin.ts`: PIN request, challenge/proof discriminated unions and pure consumption decisions.
- `packages/contracts/src/auth/operations.ts`: ADR-11 lifecycle envelope and immutable A7 operation matrix.
- `packages/contracts/src/envelope/server-envelope.ts`: consume browser/Edge provenance instead of caller-shaped actor/tenant.
- `packages/contracts/src/envelope/responses.ts`: auth error codes and fixed HTTP status mapping.
- `packages/contracts/test/auth-*.test.ts`: focused RED/GREEN suites.
- `packages/contracts/test/server-envelope.test.ts`, `packages/contracts/test/responses.test.ts`: A2 compatibility/security regressions.
- `packages/contracts/src/index.ts`, `packages/contracts/README.md`: public exports and consumer rules.
- `packages/contracts/package.json`, `tests/foundation/workspace.test.mjs`: restricted subpath exports and import-boundary lint.
- `docs/superpowers/plans/tasks/m1-acceptance/a5-session-csrf.md`: reproducible acceptance sheet.

Every exported factory/evaluator taking `unknown` must first use `auth/plain-data.ts` to capture one exact own-data descriptor snapshot. Each focused suite must prove getters are not executed and reject missing/extra keys, class instances, boxed values, accessor properties and unstable/non-plain Proxy inputs. Direct Zod schemas remain data descriptions for A7; security claims attach to the snapshotting factory boundary, not to `z.strictObject()` alone.

Every implementation commit ends with `Co-Authored-By: Codex <codex@openai.com>`.

### Task 1: Session claims, active/version check and provenance sources

**Files:**

- Create: `packages/contracts/src/auth/session.ts`
- Create: `packages/contracts/src/auth/plain-data.ts`
- Create: `packages/contracts/src/auth/source-registry.ts`
- Create: `packages/contracts/src/auth/browser-ingress.ts`
- Create: `packages/contracts/src/auth/edge-ingress.ts`
- Create: `packages/contracts/test/auth-session.test.ts`
- Modify: `packages/contracts/src/envelope/server-envelope.ts`
- Modify: `packages/contracts/test/server-envelope.test.ts`
- Modify: `packages/contracts/test/envelope-types.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/package.json`
- Modify: `tests/foundation/workspace.test.mjs`

- [ ] **Step 1: Write failing session tests**

Cover exact 900-second TTL, strict claims, active/version/actor/tenant/device comparison, revoked/missing/mismatch fail-closed, deep immutability and provenance rejection for plain/spread/JSON objects. Every unknown-input factory must reject class instances, accessor-bearing objects without executing getters, extra/missing keys and unstable Proxy descriptors.

The public shape must be equivalent to:

```ts
type AccessTokenClaims = Readonly<{
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

type AuthenticatedExecutionSource = BrowserSessionSource | EdgeReplaySource;
```

Also assert A2 rejects a caller-shaped `{actor,tenant}` and source/via mismatches; ui/ai/automation require browser provenance and edge_replay requires Edge provenance.

Browser ingress must accept an active, current session record only. Edge ingress must require one exact input containing a server-verified device-session context plus the parsed A4 queue envelope and its grant/lease authorization summary:

```ts
type VerifiedEdgeReplayInput = Readonly<{
  device_session_id: string;
  org_id: string;
  store_id: string;
  staff_id: string;
  device_id: string;
  permission_version: number;
  queue_envelope: EdgeQueueEnvelope;
}>;
```

The root export must not expose either issue factory. Package subpaths are exactly `@laundry/contracts/browser-auth-ingress` and `@laundry/contracts/edge-auth-ingress`; foundation lint rejects imports outside `apps/server/src/auth/**` and `apps/server/src/edge-ingress/**` respectively.

- [ ] **Step 2: Run tests to verify RED**

Run: `pnpm --filter @laundry/contracts test -- auth-session server-envelope`

Expected: FAIL because `auth/session.ts` exports and the new A2 API do not exist.

- [ ] **Step 3: Implement the minimum session module and A2 adapter**

Use the descriptor-based plain-data snapshot before Zod. Keep browser and Edge authority factories in separate subpath modules backed by a package-internal registry; root exports only types/guards. Do not export an assertion/cast path. Make `injectAuthenticatedCommandContext(wire, source)` derive actor/tenant/via only from the branded union. Add an architecture import scan to the existing foundation test.

- [ ] **Step 4: Run focused GREEN checks**

Run: `pnpm --filter @laundry/contracts test -- auth-session server-envelope envelope-types`

Run: `pnpm --filter @laundry/contracts typecheck`

Run: `node --test tests/foundation/workspace.test.mjs`

Expected: PASS, including all existing A2 tests updated to use a test authority.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/auth packages/contracts/test/auth-session.test.ts \
  packages/contracts/src/envelope/server-envelope.ts packages/contracts/test/server-envelope.test.ts \
  packages/contracts/test/envelope-types.test.ts packages/contracts/src/index.ts \
  packages/contracts/package.json tests/foundation/workspace.test.mjs
git commit -m "[LAUNDRY][CONTRACTS] 冻结认证会话来源"
```

### Task 2: Refresh rotation, reuse, cookie and logout contracts

**Files:**

- Create: `packages/contracts/src/auth/refresh.ts`
- Create: `packages/contracts/test/auth-refresh.test.ts`

- [ ] **Step 1: Write failing refresh tests**

Assert `REFRESH_TOKEN_TTL_SECONDS === 1_209_600`, exact `__Host-laundry_refresh` attributes, active→rotated decision, rotated reuse→revoke family+session, revoked/expired/unknown uniform rejection, session-version increment and logout clear-cookie attributes. Test every revocation cause: `logout | refresh_reuse | pin_switch | admin_revoke | credential_change`.

Use a pure decision input/output rather than a fake repository:

```ts
type RefreshMutationPlan =
  | Readonly<{
      kind: "rotate";
      compare: Readonly<{
        token_id: string;
        token_status: "active";
        family_id: string;
        family_status: "active";
        session_id: string;
        session_version: number;
      }>;
      effects: Readonly<{
        replacement_token_id: string;
        mark_token_rotated: true;
        revoke_session: false;
      }>;
    }>
  | Readonly<{
      kind: "revoke";
      cause: "refresh_reuse" | "logout" | "pin_switch" | "admin_revoke" | "credential_change";
      revoke_family: true;
      revoke_session: true;
      next_session_version: number;
    }>
  | Readonly<{ kind: "reject"; public_code: "AUTHENTICATION_FAILED" }>;
```

- [ ] **Step 2: Run tests to verify RED**

Run: `pnpm --filter @laundry/contracts test -- auth-refresh`

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement minimal immutable schemas/decisions**

Model family and token records as discriminated unions, including `replacement_token_id` only on rotated tokens. Accept trusted `now_epoch_seconds` and a server-generated replacement token id as exact plain-data inputs, never `Date.now()`. Return no token/hash value. Export a CAS commit classifier where exactly one matched row is success and zero rows means stale/reload-and-reject; A5 does not claim concurrent single-winner without C6 enforcing the compare block. Login/PIN replacement plans must revoke the previous session/family before creating the next; logout storage no-op and repeated HTTP 401 remain distinct assertions.

- [ ] **Step 4: Run focused GREEN checks**

Run: `pnpm --filter @laundry/contracts test -- auth-refresh`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/auth/refresh.ts packages/contracts/test/auth-refresh.test.ts
git commit -m "[LAUNDRY][CONTRACTS] 冻结 refresh 轮换与撤销"
```

### Task 3: CSRF double-submit and Origin contract

**Files:**

- Create: `packages/contracts/src/auth/csrf.ts`
- Create: `packages/contracts/test/auth-csrf.test.ts`

- [ ] **Step 1: Write failing CSRF tests**

Assert exact `__Host-laundry_csrf`/`x-csrf-token` constants and cookie attributes. Test safe methods GET/HEAD/OPTIONS, unsafe POST/PUT/PATCH/DELETE, absent/malformed tokens, C6-reported mismatch/invalid proof, disallowed Origin/Fetch Metadata and no token contents in failure output.

The evaluator input must be strict and dependency-injected:

```ts
type CsrfRequestFacts = Readonly<{
  method: "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" | "PATCH" | "DELETE";
  origin_allowed: boolean;
  fetch_site: "same-origin" | "same-site" | "cross-site" | "none";
  cookie_present: boolean;
  header_present: boolean;
  tokens_match: boolean;
  proof_valid: boolean;
}>;
```

- [ ] **Step 2: Run tests to verify RED**

Run: `pnpm --filter @laundry/contracts test -- auth-csrf`

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement minimal evaluator**

Validate each transport token separately with a versioned opaque proof schema, but do not compare raw secrets in contracts. C6 supplies `tokens_match` using a platform constant-time primitive and `proof_valid` after MAC/session binding. A5 returns only `{allowed:true}` or a fixed reason enum and never receives a key or echoes a token.

- [ ] **Step 4: Run focused GREEN checks**

Run: `pnpm --filter @laundry/contracts test -- auth-csrf`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/auth/csrf.ts packages/contracts/test/auth-csrf.test.ts
git commit -m "[LAUNDRY][CONTRACTS] 冻结 CSRF 双提交契约"
```

### Task 4: PIN quick-switch and step-up challenge/proof

**Files:**

- Create: `packages/contracts/src/auth/pin.ts`
- Create: `packages/contracts/test/auth-pin.test.ts`

- [ ] **Step 1: Write failing PIN tests**

Assert PIN is untrimmed 4–8 ASCII digits and never returned. Test 120-second challenge TTL, five-attempt ceiling, expired/consumed/exhausted/purpose mismatch rejection and immutable outputs. Both challenge variants copy and compare `challenge_id/session_id/session_version/org_id/store_id/device_id/nonce/issued_at/expires_at`. Quick-switch additionally binds requester/target and its success decision explicitly revokes the previous session/family before creating a new session/family.

Step-up must bind:

```ts
type StepUpBinding = Readonly<{
  pending_action_ref: string;
  args_hash: string;
  entity_versions: readonly Readonly<{ entity_type: string; entity_id: string; version: number }>[];
  idempotency_key: string;
  requester_staff_id: string;
  approver_staff_id: string;
}>;
```

Assert requester≠approver, exact field-by-field challenge→proof binding, five-minute proof TTL, expiry and one-time consumed state. Step-up success keeps the current actor/session unchanged; quick-switch success changes them only through the replacement plan.

- [ ] **Step 2: Run tests to verify RED**

Run: `pnpm --filter @laundry/contracts test -- auth-pin`

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement discriminated unions and pure decisions**

Use separate quick_switch/step_up schemas, SHA-256 hex for `args_hash`, duplicate-free entity snapshots and strict integer epochs. Do not hash PIN or persist attempts in contracts.

- [ ] **Step 4: Run focused GREEN checks**

Run: `pnpm --filter @laundry/contracts test -- auth-pin`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/auth/pin.ts packages/contracts/test/auth-pin.test.ts
git commit -m "[LAUNDRY][CONTRACTS] 冻结 PIN 与 step-up 绑定"
```

### Task 5: Lifecycle envelope, auth errors and A7 operation matrix

**Files:**

- Create: `packages/contracts/src/auth/operations.ts`
- Create: `packages/contracts/test/auth-operations.test.ts`
- Modify: `packages/contracts/src/envelope/responses.ts`
- Modify: `packages/contracts/test/responses.test.ts`

- [ ] **Step 1: Write failing operation/error tests**

Assert a provenance-checked `IdentityLifecycleEnvelope` only accepts login/refresh/logout and has no actor/tenant/dry_run/confirm_ref. Freeze these exact rows:

| Operation     | Method/path                                              | Ingress         | Requirements                                  | Cookie effect                                       |
| ------------- | -------------------------------------------------------- | --------------- | --------------------------------------------- | --------------------------------------------------- |
| login         | `POST /api/v2/auth/login`                                | lifecycle HTTP  | Origin/Fetch Metadata; no access/refresh/CSRF | set refresh + CSRF                                  |
| refresh       | `POST /api/v2/auth/refresh`                              | lifecycle HTTP  | Origin + refresh + CSRF; no access            | rotate refresh + CSRF                               |
| logout        | `POST /api/v2/auth/logout`                               | lifecycle HTTP  | Origin + refresh + CSRF; no access required   | clear refresh + CSRF                                |
| PIN challenge | `POST /api/v2/auth/pin/challenges`                       | browser session | Origin + access + CSRF                        | none                                                |
| PIN verify    | `POST /api/v2/auth/pin/challenges/{challenge_id}/verify` | browser session | Origin + access + CSRF                        | quick-switch replaces session cookies; step-up none |

Strict browser schemas are fixed in this task:

```ts
type LoginRequest = Readonly<{
  org_code: string;
  store_code: string;
  username: string;
  password: string;
  device_id: string;
}>;
type EmptyBody = Readonly<Record<never, never>>;
type PinChallengeRequest =
  | Readonly<{ purpose: "quick_switch"; target_staff_id: string }>
  | Readonly<{ purpose: "step_up"; pending_action_ref: string; approver_staff_id: string }>;
type PinVerifyRequest = Readonly<{ challenge_id: string; pin: string }>;
type AccessSessionResponse = Readonly<{
  access_token: string;
  token_type: "Bearer";
  expires_in: 900;
  storage: "memory_only";
  session: Readonly<{
    session_id: string;
    session_version: number;
    org_id: string;
    store_id: string;
    staff_id: string;
    device_id: string;
    permission_version: number;
  }>;
}>;
```

Login/refresh return `AccessSessionResponse`; logout returns `{logged_out:true}`; challenge returns only `challenge_id/purpose/expires_at/max_attempts`; verify returns either a replacement `AccessSessionResponse` or opaque `step_up_proof_id/expires_at`. Password/PIN/refresh/CSRF and server bindings never appear in a response.

Add exact fixed messages/status:

```ts
AUTHENTICATION_FAILED -> { message: "Authentication failed", http_status: 401 }
CSRF_REJECTED -> { message: "Request origin verification failed", http_status: 403 }
RATE_LIMITED -> { message: "Too many requests", http_status: 429 }
```

Each matrix row lists its allowed existing A2 errors plus the applicable auth errors, so A7 performs no status inference. The matrix exposes literal schema ids and browser-safe Zod schemas; lifecycle provenance metadata and cookie effects are immutable literal data.

Unknown/revoked/reused refresh must all emit identical `AUTHENTICATION_FAILED` public output.

- [ ] **Step 2: Run tests to verify RED**

Run: `pnpm --filter @laundry/contracts test -- auth-operations responses`

Expected: FAIL because lifecycle exports/error codes are absent.

- [ ] **Step 3: Implement immutable matrix and A2 extensions**

Use fixed literal rows and a `WeakSet` lifecycle-ingress authority available only from the browser-ingress subpath. Keep browser-visible schema ids separate from server-only schemas so A7 cannot project refresh hashes or authority factories. All unknown factory inputs pass through the auth plain-data membrane before Zod.

- [ ] **Step 4: Run focused GREEN checks**

Run: `pnpm --filter @laundry/contracts test -- auth-operations responses`

Expected: PASS, with pre-existing A2 error tests unchanged except exhaustive additions.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/auth/operations.ts packages/contracts/test/auth-operations.test.ts \
  packages/contracts/src/envelope/responses.ts packages/contracts/test/responses.test.ts
git commit -m "[LAUNDRY][CONTRACTS] 冻结身份生命周期入口"
```

### Task 6: Public exports, acceptance docs and full regression

**Files:**

- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/README.md`
- Create: `docs/superpowers/plans/tasks/m1-acceptance/a5-session-csrf.md`
- Modify: `docs/superpowers/plans/tasks/m1-acceptance/README.md`

- [ ] **Step 1: Write/extend export and consumer tests**

Update `packages/contracts/test/consumers.test.ts` and type tests so public browser schemas fail to import before exports are added, while server authority issue methods remain absent from the root entry point. Assert secret-bearing request schemas have no examples/result echoes.

- [ ] **Step 2: Run tests to verify RED**

Run: `pnpm --filter @laundry/contracts test -- consumers auth-`

Run: `pnpm --filter @laundry/contracts typecheck`

Expected: FAIL because the remaining public auth exports are not yet wired.

- [ ] **Step 3: Export APIs and keep authority factories off the root**

Export browser schemas, decisions, guards and types from `src/index.ts`; export browser/Edge authority factories only through their restricted package subpaths. Update consumer/type tests and run the same commands to GREEN.

- [ ] **Step 4: Write acceptance documentation**

Document contract-only evidence, RED/GREEN commands, ADR-11, C6/C8 runtime gaps, A7 projection rules and exact negative assertions. Mark A5 only as a freeze candidate until PR/main CI pass.

- [ ] **Step 5: Run fresh full verification**

Run:

```bash
pnpm --filter @laundry/contracts test
pnpm --filter @laundry/contracts typecheck
pnpm --filter @laundry/contracts lint
pnpm run workspace:check
git diff --check origin/main...HEAD
git diff --exit-code origin/main -- package-lock.json pnpm-lock.yaml
```

Expected: all zero; coverage remains ≥70%; both lockfiles remain unchanged because A5 adds no dependency.

- [ ] **Step 6: Independent reviews**

Request whole-range spec, TypeScript quality and security reviews. Fix every blocker/major with a new failing regression before implementation; rerun all reviewers after fixes.

- [ ] **Step 7: Commit docs/exports**

```bash
git add packages/contracts/src/index.ts packages/contracts/test/consumers.test.ts \
  packages/contracts/README.md docs/superpowers/plans/tasks/m1-acceptance/
git commit -m "[LAUNDRY][CONTRACTS] 记录 A5 冻结证据"
```

- [ ] **Step 8: PR/CI/main verification**

Fetch/rebase `origin/main`, rerun fresh checks, push `codex/m1-a5-session-csrf`, create one A5 PR, wait for Build/Release and V2 Foundation, merge only when CLEAN under ADR-10 and manpengan's current written authorization, then verify both workflows on the merge commit.
