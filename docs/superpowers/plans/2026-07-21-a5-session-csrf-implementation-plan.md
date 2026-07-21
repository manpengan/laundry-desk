# A5 Session, Refresh, CSRF and PIN Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze executable contract-only semantics for browser sessions, refresh rotation/reuse, CSRF, PIN quick-switch/step-up and identity lifecycle operations without implementing C6 persistence or cryptography.

**Architecture:** Add focused `auth/*` modules with strict Zod schemas, immutable outputs, runtime provenance guards and pure state decisions. Patch A2 so normal command envelopes consume a provenance-checked browser/Edge source union, while ADR-11 lifecycle operations use a narrow pre-auth envelope and the same public error envelope.

**Tech Stack:** TypeScript strict, Zod 4, Vitest 3, existing `@laundry/contracts` patterns, pnpm/Turborepo.

---

## File map

- `packages/contracts/src/auth/session.ts`: access/session shapes, active/version check, source authority and provenance guards.
- `packages/contracts/src/auth/refresh.ts`: TTL/cookie descriptors, refresh state/reuse/logout decisions and clear-cookie descriptors.
- `packages/contracts/src/auth/csrf.ts`: CSRF proof/request schema, safe-method classification and non-leaking decision.
- `packages/contracts/src/auth/pin.ts`: PIN request, challenge/proof discriminated unions and pure consumption decisions.
- `packages/contracts/src/auth/operations.ts`: ADR-11 lifecycle envelope and immutable A7 operation matrix.
- `packages/contracts/src/envelope/server-envelope.ts`: consume browser/Edge provenance instead of caller-shaped actor/tenant.
- `packages/contracts/src/envelope/responses.ts`: auth error codes and fixed HTTP status mapping.
- `packages/contracts/test/auth-*.test.ts`: focused RED/GREEN suites.
- `packages/contracts/test/server-envelope.test.ts`, `packages/contracts/test/responses.test.ts`: A2 compatibility/security regressions.
- `packages/contracts/src/index.ts`, `packages/contracts/README.md`: public exports and consumer rules.
- `docs/superpowers/plans/tasks/m1-acceptance/a5-session-csrf.md`: reproducible acceptance sheet.

### Task 1: Session claims, active/version check and provenance sources

**Files:**

- Create: `packages/contracts/src/auth/session.ts`
- Create: `packages/contracts/test/auth-session.test.ts`
- Modify: `packages/contracts/src/envelope/server-envelope.ts`
- Modify: `packages/contracts/test/server-envelope.test.ts`

- [ ] **Step 1: Write failing session tests**

Cover exact 900-second TTL, strict claims, active/version/actor/tenant/device comparison, revoked/missing/mismatch fail-closed, deep immutability and provenance rejection for plain/spread/JSON objects.

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

- [ ] **Step 2: Run tests to verify RED**

Run: `pnpm --filter @laundry/contracts test -- auth-session server-envelope`

Expected: FAIL because `auth/session.ts` exports and the new A2 API do not exist.

- [ ] **Step 3: Implement the minimum session module and A2 adapter**

Use strict schemas, `WeakSet` provenance registration and frozen copies. Export one authority factory whose issue methods validate active/current records before registering a source; do not export an assertion/cast path. Make `injectAuthenticatedCommandContext(wire, source)` derive actor/tenant/via only from the branded union.

- [ ] **Step 4: Run focused GREEN checks**

Run: `pnpm --filter @laundry/contracts test -- auth-session server-envelope`

Expected: PASS, including all existing A2 tests updated to use a test authority.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/auth/session.ts packages/contracts/test/auth-session.test.ts \
  packages/contracts/src/envelope/server-envelope.ts packages/contracts/test/server-envelope.test.ts
git commit -m "[LAUNDRY][CONTRACTS] 冻结认证会话来源"
```

### Task 2: Refresh rotation, reuse, cookie and logout contracts

**Files:**

- Create: `packages/contracts/src/auth/refresh.ts`
- Create: `packages/contracts/test/auth-refresh.test.ts`

- [ ] **Step 1: Write failing refresh tests**

Assert `REFRESH_TOKEN_TTL_SECONDS === 1_209_600`, exact `__Host-laundry_refresh` attributes, active→rotated decision, rotated reuse→revoke family+session, revoked/expired/unknown uniform rejection, concurrent old-token second use rejection, session-version increment and logout clear-cookie attributes.

Use a pure decision input/output rather than a fake repository:

```ts
type RefreshDecision =
  | Readonly<{ kind: "rotate"; revoke_session: false }>
  | Readonly<{ kind: "reuse"; revoke_family: true; revoke_session: true }>
  | Readonly<{ kind: "reject"; public_code: "AUTHENTICATION_FAILED" }>;
```

- [ ] **Step 2: Run tests to verify RED**

Run: `pnpm --filter @laundry/contracts test -- auth-refresh`

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement minimal immutable schemas/decisions**

Model token status as a discriminated union. Accept trusted `now_epoch_seconds` as an integer input, never `Date.now()`. Return no token/hash value. Keep storage locking/atomic update in C6, but make the expected compare-and-swap outcome explicit.

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

Assert exact `__Host-laundry_csrf`/`x-csrf-token` constants and cookie attributes. Test safe methods GET/HEAD/OPTIONS, unsafe POST/PUT/PATCH/DELETE, absent/malformed/mismatched tokens, disallowed Origin/Fetch Metadata and no token contents in failure output.

The evaluator input must be strict and dependency-injected:

```ts
type CsrfRequestFacts = Readonly<{
  method: "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" | "PATCH" | "DELETE";
  origin_allowed: boolean;
  fetch_site: "same-origin" | "same-site" | "cross-site" | "none";
  cookie_token?: string;
  header_token?: string;
  proof_valid: boolean;
}>;
```

- [ ] **Step 2: Run tests to verify RED**

Run: `pnpm --filter @laundry/contracts test -- auth-csrf`

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement minimal evaluator**

Validate versioned opaque tokens, compare equal-length ASCII without early byte exit, and return only `{allowed:true}` or a fixed reason enum. `proof_valid` is supplied by C6 after MAC/session binding; contracts never receives a key.

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

Assert PIN is untrimmed 4–8 ASCII digits and never returned. Test 120-second challenge TTL, five-attempt ceiling, expired/consumed/exhausted/purpose mismatch rejection and immutable outputs. Quick-switch must bind requester/target/session/version and require a new session/family outcome.

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

Assert requester≠approver, exact binding comparison, five-minute proof TTL, expiry and one-time consumed state.

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

Assert a provenance-checked `IdentityLifecycleEnvelope` only accepts login/refresh/logout and has no actor/tenant/dry_run/confirm_ref. Freeze matrix rows for login/refresh/logout/PIN challenge/PIN verify, including method/path, auth source, Origin/CSRF/access/refresh requirements, request/response schema ids, cookie effects and allowed error/status pairs.

Add exact fixed messages/status:

```ts
AUTHENTICATION_FAILED -> 401
CSRF_REJECTED -> 403
RATE_LIMITED -> 429
```

Unknown/revoked/reused refresh must all emit identical `AUTHENTICATION_FAILED` public output.

- [ ] **Step 2: Run tests to verify RED**

Run: `pnpm --filter @laundry/contracts test -- auth-operations responses`

Expected: FAIL because lifecycle exports/error codes are absent.

- [ ] **Step 3: Implement immutable matrix and A2 extensions**

Use fixed literal rows and a `WeakSet` lifecycle-ingress authority. Keep browser-visible schema ids separate from server-only schemas so A7 cannot project refresh hashes or authority factories.

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

Update `packages/contracts/test/consumers.test.ts` and type tests so public browser schemas compile while server authorities/state are explicitly documented as non-OpenAPI inputs. Assert secret-bearing request schemas have no examples/result echoes.

- [ ] **Step 2: Run focused tests and typecheck**

Run: `pnpm --filter @laundry/contracts test -- consumers auth-`

Run: `pnpm --filter @laundry/contracts typecheck`

Expected: PASS.

- [ ] **Step 3: Export APIs and write acceptance documentation**

Document contract-only evidence, RED/GREEN commands, ADR-11, C6/C8 runtime gaps, A7 projection rules and exact negative assertions. Mark A5 only as a freeze candidate until PR/main CI pass.

- [ ] **Step 4: Run fresh full verification**

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

- [ ] **Step 5: Independent reviews**

Request whole-range spec, TypeScript quality and security reviews. Fix every blocker/major with a new failing regression before implementation; rerun all reviewers after fixes.

- [ ] **Step 6: Commit docs/exports**

```bash
git add packages/contracts/src/index.ts packages/contracts/test/consumers.test.ts \
  packages/contracts/README.md docs/superpowers/plans/tasks/m1-acceptance/
git commit -m "[LAUNDRY][CONTRACTS] 记录 A5 冻结证据"
```

- [ ] **Step 7: PR/CI/main verification**

Fetch/rebase `origin/main`, rerun fresh checks, push `codex/m1-a5-session-csrf`, create one A5 PR, wait for Build/Release and V2 Foundation, merge only when CLEAN, then verify both workflows on the merge commit.
