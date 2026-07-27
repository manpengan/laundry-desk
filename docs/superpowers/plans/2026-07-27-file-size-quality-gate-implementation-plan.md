# File Size Quality Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the approved 400-line production and 800-line test budgets across active V2 code while freezing, but not enlarging, the 16 existing production exceptions.

**Architecture:** ESLint remains the single real-file enforcement mechanism. The shared workspace config owns the default production and test budgets, package-local overrides own exact frozen exceptions, and the root config is narrowly scoped to `tools/local/**` plus `tests/foundation/**`; a Node test exercises resolved ESLint configurations at both boundaries and verifies the frozen inventory.

**Tech Stack:** ESLint 8 Node API, Node.js test runner, pnpm/turbo, JavaScript/TypeScript monorepo configuration.

---

The spec and this plan are committed before Task 1 starts. That documentation commit is part of
the delivery history, so Task 5 begins from a tracked, clean planning baseline.

### Task 1: Add failing configuration-contract tests

**Files:**

- Create: `tests/foundation/eslint-file-size.test.mjs`
- Modify later: `.eslintrc.cjs`
- Modify later: `packages/config/eslint/base.cjs`
- Modify later: package `.eslintrc.cjs` files

- [ ] **Step 1: Write the virtual-file boundary test**

Create an `ESLint` instance rooted at the repository and lint comment-only virtual files so no unrelated lint rule affects the assertions:

```js
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ESLint } from "eslint";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const eslint = new ESLint({ cwd: repositoryRoot });

function sourceWithPhysicalLines(lineCount) {
  return Array.from({ length: lineCount }, (_, index) => `// line ${index + 1}`).join("\n");
}

async function maxLineMessages(filePath, lineCount) {
  const [result] = await eslint.lintText(sourceWithPhysicalLines(lineCount), { filePath });
  return result.messages.filter(({ ruleId }) => ruleId === "max-lines");
}

test("enforces 400 production lines and 800 test lines", async () => {
  assert.equal((await maxLineMessages("apps/server/src/file-size-probe.ts", 400)).length, 0);
  assert.equal((await maxLineMessages("apps/server/src/file-size-probe.ts", 401)).length, 1);
  assert.equal((await maxLineMessages("apps/server/src/file-size-probe.test.ts", 800)).length, 0);
  assert.equal((await maxLineMessages("apps/server/src/file-size-probe.test.ts", 801)).length, 1);
});
```

- [ ] **Step 2: Add resolved-config coverage**

In the same file, declare the approved 16-entry frozen inventory and assert that
`calculateConfigForFile()` resolves each file to its exact `max-lines` value. Also assert:

```js
assert.equal((await eslint.calculateConfigForFile("src/main.ts")).rules["max-lines"], undefined);
assert.equal(maxLinesFrom(await eslint.calculateConfigForFile("tools/local/probe.mjs")), 400);
assert.equal(
  maxLinesFrom(await eslint.calculateConfigForFile("tests/foundation/probe.test.mjs")),
  800,
);
```

`maxLinesFrom()` must accept ESLint's normalized rule representation and return the configured
`max` number.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
node --test tests/foundation/eslint-file-size.test.mjs
```

Expected: FAIL because `max-lines` is not configured, so the 401-line production probe is
not rejected and the frozen budgets are absent.

- [ ] **Step 4: Commit the RED test**

```bash
git add tests/foundation/eslint-file-size.test.mjs
git commit -m "[LAUNDRY_DESK][QUALITY] 增加文件规模门禁回归测试"
```

### Task 2: Configure default and frozen ESLint budgets

**Files:**

- Modify: `packages/config/eslint/base.cjs`
- Modify: `.eslintrc.cjs`
- Modify: `apps/edge-agent/.eslintrc.cjs`
- Modify: `apps/server/.eslintrc.cjs`
- Modify: `apps/web/.eslintrc.cjs`
- Modify: `packages/contracts/.eslintrc.cjs`
- Modify: `package.json`
- Test: `tests/foundation/eslint-file-size.test.mjs`

- [ ] **Step 1: Add the shared default**

Add the production budget to `packages/config/eslint/base.cjs`:

```js
"max-lines": [
  "error",
  {
    max: 400,
    skipBlankLines: false,
    skipComments: false,
  },
],
```

Add an `overrides` entry setting the same rule to 800 for all of:

```js
[
  "**/*.test.*",
  "**/*.spec.*",
  "test/**",
  "tests/**",
  "**/test/**",
  "**/tests/**",
  "__tests__/**",
  "**/__tests__/**",
  "e2e/**",
  "**/e2e/**",
];
```

- [ ] **Step 2: Scope the root rules**

Keep root-level `rules` free of `max-lines`. Add `overrides` that:

- apply 400 only to `tools/local/**/*.mjs`;
- apply 800 only to `tests/foundation/**/*.mjs`;
- apply 474 only to `tools/local/config.mjs`.

No rule may cover frozen root `src/`.

- [ ] **Step 3: Add exact package-local freezes**

Add narrow `overrides.files` entries with these current physical budgets:

```text
apps/edge-agent/src/desktop/http-transport.ts                       799
apps/edge-agent/scripts/sync-spa.mjs                               687
apps/server/src/local/bootstrap.ts                                 795
apps/server/src/identity/pg-store.ts                               773
apps/server/src/http/login-rate-limit.ts                           632
apps/server/src/order/pg-order-store.ts                            506
apps/server/src/identity/memory-store.ts                           481
apps/server/src/local/create-runtime.ts                            457
apps/server/src/identity/pg-pin-repo.ts                            456
apps/server/src/identity/session.ts                                418
apps/web/src/host/desktop-ports.ts                                 671
apps/web/src/auth/HttpAuthClient.ts                                534
apps/web/src/pages/ReceivePage.tsx                                 411
packages/contracts/src/auth/pin.ts                                 549
packages/contracts/src/index.ts                                    533
tools/local/config.mjs                                             474
```

Package override paths must be relative to that package's ESLint config.

- [ ] **Step 4: Put real foundation files in the default lint gate**

Change the root script to:

```json
"workspace:lint": "eslint tools/local tests/foundation --ext .mjs --max-warnings=0 && turbo run lint"
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
node --test tests/foundation/eslint-file-size.test.mjs
```

Expected: PASS for 400/401, 800/801, root scoping, and all 16 exact freezes.

- [ ] **Step 6: Run the real lint gate and observe the remaining hard failure**

Run:

```bash
pnpm workspace:lint
```

Expected: FAIL only because `tests/foundation/local-foundation.test.mjs` is 854 lines,
proving the real-file 800-line gate is active before the test split.

- [ ] **Step 7: Commit the GREEN configuration**

```bash
git add .eslintrc.cjs package.json packages/config/eslint/base.cjs \
  apps/edge-agent/.eslintrc.cjs apps/server/.eslintrc.cjs \
  apps/web/.eslintrc.cjs packages/contracts/.eslintrc.cjs
git commit -m "[LAUNDRY_DESK][QUALITY] 启用文件规模自动门禁"
```

### Task 3: Split the only file above the hard test limit

**Files:**

- Modify: `tests/foundation/local-foundation.test.mjs`
- Create: `tests/foundation/local-foundation-http-smoke.test.mjs`

- [ ] **Step 1: Move the HTTP smoke test unit**

Move, without changing assertions or behavior:

- imports needed only by the HTTP smoke tests;
- `createHttpSmokeFakes`;
- `httpSmokeSecretEnvironment`;
- `keeps the HTTP smoke administrator password out of child argv and environments`;
- `redacts HTTP smoke request, response, and token material on login failure`.

The new file must define the same `rootUrl` and private helpers. Remove only imports that become
unused in the original file.

- [ ] **Step 2: Verify both files are within the hard budget**

Run:

```bash
wc -l tests/foundation/local-foundation.test.mjs \
  tests/foundation/local-foundation-http-smoke.test.mjs
```

Expected: each file is at most 800 physical lines.

- [ ] **Step 3: Run foundation tests**

Run:

```bash
node --test tests/foundation/*.test.mjs
```

Expected: all foundation tests PASS, including the moved HTTP smoke assertions.

- [ ] **Step 4: Run the real lint gate**

Run:

```bash
pnpm workspace:lint
```

Expected: PASS with no warnings.

- [ ] **Step 5: Commit the focused split**

```bash
git add tests/foundation/local-foundation.test.mjs \
  tests/foundation/local-foundation-http-smoke.test.mjs
git commit -m "[LAUNDRY_DESK][QUALITY] 拆分超限基础测试"
```

### Task 4: Record the repository policy

**Files:**

- Modify: `AGENTS.md`
- Test: `tests/foundation/local-foundation.test.mjs`

- [ ] **Step 1: Add a failing governance assertion**

Add a foundation assertion requiring repository `AGENTS.md` to state:

- active V2 production files default to 400 physical lines;
- tests hard-stop at 800 physical lines;
- named frozen budgets cannot grow.

- [ ] **Step 2: Run the focused test and verify RED**

Run the new test by name:

```bash
node --test --test-name-pattern="records the active V2 file size policy" \
  tests/foundation/local-foundation.test.mjs
```

Expected: FAIL because the policy is not yet in `AGENTS.md`.

- [ ] **Step 3: Add the concise policy**

Add a repository policy section to `AGENTS.md` using the approved wording and link to:

```text
docs/superpowers/specs/2026-07-27-file-size-quality-gate-design.md
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Repeat the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Commit policy and assertion**

```bash
git add AGENTS.md tests/foundation/local-foundation.test.mjs
git commit -m "[LAUNDRY_DESK][QUALITY] 记录活动代码规模政策"
```

### Task 5: Verify, integrate to GitHub main, and clean the temporary lane

**Files:**

- Verify all files changed by Tasks 1–4.

- [ ] **Step 1: Run formatting and diff checks**

```bash
pnpm exec prettier --write \
  AGENTS.md package.json .eslintrc.cjs packages/config/eslint/base.cjs \
  apps/edge-agent/.eslintrc.cjs apps/server/.eslintrc.cjs \
  apps/web/.eslintrc.cjs packages/contracts/.eslintrc.cjs \
  tests/foundation/eslint-file-size.test.mjs \
  tests/foundation/local-foundation.test.mjs \
  tests/foundation/local-foundation-http-smoke.test.mjs
git diff --check
```

Expected: clean formatting and no whitespace errors.

- [ ] **Step 2: Run the complete repository gate**

```bash
pnpm workspace:check
```

Expected: format, lint, strict typecheck, all tests, and all builds PASS.

- [ ] **Step 3: Confirm branch and remote state**

```bash
git status --short
git fetch --prune origin
git merge-base --is-ancestor origin/main HEAD
```

Expected: clean worktree and the local delivery branch contains current `origin/main`.

- [ ] **Step 4: Fast-forward local main in its existing worktree**

From `/Users/manpengan/pro/laundry-desk`:

```bash
git status --short
git pull --ff-only origin main
git merge --ff-only codex/local-first-v2
```

Expected: clean `main` fast-forwards to the verified delivery commit without a merge commit.

- [ ] **Step 5: Re-run the complete gate on merged main**

```bash
pnpm workspace:check
```

Expected: PASS again from `/Users/manpengan/pro/laundry-desk`.

- [ ] **Step 6: Push and verify GitHub main**

```bash
git push origin main
git ls-remote --heads origin main
git rev-parse HEAD
```

Expected: remote `main` SHA equals local `main` SHA. Do not write to Gitea.

- [ ] **Step 7: Remove the temporary worktree and branch**

From outside the temporary worktree:

```bash
git worktree remove /Users/manpengan/pro/laundry-codex-local-first
git branch -d codex/local-first-v2
git fetch --prune origin
```

Expected: the temporary worktree and local branch are gone. If a remote temporary branch exists,
delete it only after confirming GitHub `main` contains its tip; never push the temporary branch.
