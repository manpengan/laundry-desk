# A1 Command Registry Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the runtime-validated, type-safe command/query definition contract that later M1 command bus, Policy, AI projection, and Edge work can share.

**Architecture:** Keep Zod input schemas as generic runtime objects while validating all serialisable metadata through strict Zod schemas. Expose immutable `defineCommand`/`defineQuery` results; query definitions encode fail-closed read-only constraints as literals rather than post-parse conventions.

**Tech Stack:** TypeScript 5.9 strict mode, Zod 4, Vitest 3, pnpm/npm lockfiles, Turborepo.

---

## File map

- Modify `packages/contracts/package.json`: declare Zod/Vitest and package-local test/typecheck scripts.
- Create `packages/contracts/tsconfig.test.json`: typecheck tests without emitting them into `dist`.
- Create `packages/contracts/src/registry/schemas.ts`: stable enums, strict metadata schemas, SemVer/name/JSON Pointer validation.
- Create `packages/contracts/src/registry/definitions.ts`: generic builders, input-schema identity validation, immutable output, inference helpers.
- Modify `packages/contracts/src/index.ts`: publish only the supported A1 surface.
- Create `packages/contracts/test/registry.test.ts`: runtime and compile-time contract tests.
- Modify `pnpm-lock.yaml` and `package-lock.json`: keep both package managers in sync.

### Task 1: Wire package-local test and validation dependencies

**Files:**

- Modify: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.test.json`
- Create: `packages/contracts/vitest.config.ts`
- Create: `packages/contracts/test/tooling.test.ts`
- Modify: `pnpm-lock.yaml`
- Modify: `package-lock.json`

- [ ] **Step 1: Update package scripts and dependencies**

Use `apply_patch` so `packages/contracts/package.json` contains:

```json
{
  "scripts": {
    "lint": "eslint src test --ext .ts,.tsx --max-warnings=0",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit"
  },
  "dependencies": {
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "vitest": "^3.2.7"
  }
}
```

Preserve the existing package name, exports, build, and dev scripts.

- [ ] **Step 2: Add test-only TypeScript configuration**

Create `packages/contracts/tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": ".",
    "skipLibCheck": true,
    "types": ["vitest/globals"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

`skipLibCheck` is enabled only in the test config because Vitest 3 imports Vite 5 declarations whose Rollup peer types conflict under the production config's `exactOptionalPropertyTypes`; production `tsconfig.json` keeps `skipLibCheck: false`.

- [ ] **Step 3: Isolate contracts from the legacy root Vitest config**

Create `packages/contracts/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.{test,spec}.ts"],
  },
});
```

The package-local config is required because the legacy root config only scans `tests/unit/**`; A1 must not modify or inherit that v1 test boundary.

- [ ] **Step 4: Add a real test-toolchain smoke test**

Create `packages/contracts/test/tooling.test.ts`:

```ts
import { expect, it } from "vitest";
import { z } from "zod";

it("loads the package-local Vitest and Zod toolchain", () => {
  expect(z.string().parse("contracts-ready")).toBe("contracts-ready");
});
```

This keeps the exact lint script executable before registry behavior tests are added and proves both new direct dependencies load under ESM.

- [ ] **Step 5: Regenerate both lockfiles without lifecycle scripts**

Run:

```bash
pnpm install --lockfile-only --ignore-scripts
npm install --package-lock-only --ignore-scripts
```

Expected: both commands exit 0; only the contracts dependency graph changes.

- [ ] **Step 6: Verify dependency declarations and scope**

Run:

```bash
pnpm --filter @laundry/contracts exec vitest --version
pnpm --filter @laundry/contracts lint
pnpm --filter @laundry/contracts typecheck
pnpm --filter @laundry/contracts test
git diff --check
git diff --name-only
```

Expected: Vitest reports 3.2.x; lint, typecheck, and the one smoke test pass; changed paths are limited to the six files in this task.

- [ ] **Step 7: Commit package wiring**

```bash
git add packages/contracts/package.json packages/contracts/tsconfig.test.json packages/contracts/vitest.config.ts packages/contracts/test/tooling.test.ts pnpm-lock.yaml package-lock.json
git commit -m "chore(contracts): wire A1 validation tests" \
  -m "Co-Authored-By: Codex <codex@openai.com>"
```

### Task 2: Define strict serialisable metadata schemas

**Files:**

- Create: `packages/contracts/test/registry.test.ts`
- Create: `packages/contracts/src/registry/schemas.ts`

- [ ] **Step 1: Write failing metadata validation tests**

Create `packages/contracts/test/registry.test.ts` with a valid command fixture and table-driven negative cases. The first batch must assert:

```ts
import { describe, expect, it } from "vitest";
import { z, ZodError } from "zod";
import { defineCommand } from "../src/index.js";

const input = z.object({ orderId: z.string().uuid() });

const validCommand = {
  name: "orders.cancel",
  version: "1.0.0",
  description: "Cancel an order",
  input,
  risk: "R3" as const,
  invariants: ["orders.exists"],
  idempotent: true,
  sideEffects: ["orders.status_changed"],
  offline_allowed: false,
  data_classification: "internal" as const,
  max_batch: 1,
  result_redaction: [],
};

describe("defineCommand metadata", () => {
  it.each([
    "risk",
    "idempotent",
    "offline_allowed",
    "data_classification",
    "max_batch",
    "result_redaction",
  ] as const)("rejects a missing %s safety field", (field) => {
    const candidate = { ...validCommand } as Record<string, unknown>;
    delete candidate[field];
    expect(() => defineCommand(candidate as never)).toThrow(ZodError);
  });

  it.each([
    ["name", "Orders.Cancel"],
    ["version", "1"],
    ["max_batch", 0],
  ])("rejects invalid %s metadata", (field, value) => {
    expect(() => defineCommand({ ...validCommand, [field]: value } as never)).toThrow(ZodError);
  });
});
```

Also add negative cases for duplicate invariant/side-effect IDs, unknown fields, empty descriptions, and invalid redaction pointers such as `customer/phone` and `/customer/~phone`.

Add SemVer boundary coverage for invalid numeric prerelease leading zeros (`1.0.0-01`) and valid prerelease/build metadata (`1.0.0-rc.1+build.7`). Add valid JSON Pointer cases containing `/customer/~0tag` and `/customer/a~1b`, and assert redaction-rule order is preserved.

- [ ] **Step 2: Run the focused test to prove RED**

Run:

```bash
pnpm --filter @laundry/contracts test -- test/registry.test.ts
```

Expected: FAIL because `defineCommand` is not exported.

- [ ] **Step 3: Implement strict metadata schemas**

Create `packages/contracts/src/registry/schemas.ts` with:

```ts
import { z } from "zod";

const STABLE_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u;
const COMMAND_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const JSON_POINTER = /^(?:\/(?:[^~/]|~0|~1)*)+$/u;

const uniqueIds = (ids: readonly string[]): boolean => new Set(ids).size === ids.length;

export const RiskSchema = z.enum(["R0", "R1", "R2", "R3", "R4", "R5"]);
export const QueryRiskSchema = z.enum(["R0", "R1", "R2"]);
export const DataClassificationSchema = z.enum(["public", "internal", "pii"]);
export const ResultRedactionRuleSchema = z
  .object({
    path: z.string().regex(JSON_POINTER),
    strategy: z.enum(["remove", "mask", "last4"]),
  })
  .strict();

const idList = z.array(z.string().regex(STABLE_ID)).refine(uniqueIds, {
  message: "Identifiers must be unique",
});

const CommonMetadataShape = {
  name: z.string().regex(COMMAND_NAME),
  version: z.string().regex(SEMVER),
  description: z.string().trim().min(1),
  invariants: idList,
  data_classification: DataClassificationSchema,
  max_batch: z.number().int().positive(),
  result_redaction: z.array(ResultRedactionRuleSchema),
};

export const CommandMetadataSchema = z
  .object({
    ...CommonMetadataShape,
    kind: z.literal("command"),
    risk: RiskSchema,
    idempotent: z.boolean(),
    sideEffects: idList,
    offline_allowed: z.boolean(),
  })
  .strict();

export const QueryMetadataSchema = z
  .object({
    ...CommonMetadataShape,
    kind: z.literal("query"),
    risk: QueryRiskSchema,
    idempotent: z.literal(true),
    sideEffects: z.array(z.never()).length(0),
    offline_allowed: z.literal(false),
  })
  .strict();
```

Keep exported inferred metadata/rule types read-only; do not add defaults.

- [ ] **Step 4: Implement only enough builder plumbing for metadata tests**

Temporarily add `packages/contracts/src/registry/definitions.ts` and export it from `src/index.ts`. The builder must add `kind: "command"`, split out `input`, call `CommandMetadataSchema.parse`, and return the parsed metadata plus input. Do not implement query behavior yet.

- [ ] **Step 5: Run the focused test to prove GREEN**

Run:

```bash
pnpm --filter @laundry/contracts test -- test/registry.test.ts
```

Expected: all command metadata tests pass.

- [ ] **Step 6: Commit strict metadata validation**

```bash
git add packages/contracts/src packages/contracts/test/registry.test.ts
git commit -m "feat(contracts): validate A1 command metadata" \
  -m "Co-Authored-By: Codex <codex@openai.com>"
```

### Task 3: Complete immutable generic command/query builders

**Files:**

- Modify: `packages/contracts/test/registry.test.ts`
- Modify: `packages/contracts/src/registry/definitions.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: Add failing builder-boundary tests**

Add tests that assert:

- `defineCommand` and `defineQuery` preserve exact `input` schema and add the correct `kind`;
- a fake `{ parse() {}, safeParse() {} }` input is rejected with `ZodError`;
- queries reject R3–R5, `idempotent: false`, `offline_allowed: true`, or non-empty `sideEffects`;
- modifying the caller's original arrays/rules after construction does not alter the definition;
- `Object.isFrozen` is true for the returned definition, arrays, and redaction rules;
- writes to frozen nested metadata throw in strict ESM execution.

Use a transforming schema so input and output cannot be accidentally interchanged:

```ts
const transformingCommand = defineCommand({
  ...validCommand,
  input: z.object({ quantity: z.string().transform(Number) }),
});
expectTypeOf<InferContractInput<typeof transformingCommand>>().toEqualTypeOf<{
  quantity: string;
}>();
expectTypeOf<InferContractOutput<typeof transformingCommand>>().toEqualTypeOf<{
  quantity: number;
}>();
```

- [ ] **Step 2: Run the focused test to prove RED**

Run:

```bash
pnpm --filter @laundry/contracts test -- test/registry.test.ts
```

Expected: FAIL on missing query/input-identity/immutability behavior.

- [ ] **Step 3: Implement the generic builders and types**

Complete `packages/contracts/src/registry/definitions.ts` around these contracts:

```ts
import { z, ZodError, type ZodType } from "zod";
import {
  CommandMetadataSchema,
  QueryMetadataSchema,
  type CommandMetadata,
  type QueryMetadata,
  type ResultRedactionRule,
} from "./schemas.js";

export type ContractDefinition<
  TKind extends "command" | "query",
  TInput extends ZodType,
> = Readonly<
  (TKind extends "command" ? CommandMetadata : QueryMetadata) & {
    input: TInput;
  }
>;

export type InferContractInput<T extends { input: ZodType }> = z.input<T["input"]>;
export type InferContractOutput<T extends { input: ZodType }> = z.output<T["input"]>;
```

Builder requirements:

1. Runtime-check `definition.input instanceof z.ZodType`; if false, throw a `ZodError` with an issue at path `input`.
2. Parse strict metadata after adding the server-owned discriminator.
3. Clone/freeze `invariants`, `sideEffects`, the redaction array, and each redaction rule.
4. Freeze the final object without mutating the caller's object.
5. Never catch or replace Zod validation errors.

Use a small `freezeMetadata` helper; keep every function below 50 lines. Do not introduce `any`, mutable casts, or a runtime registry.

- [ ] **Step 4: Export the supported A1 surface**

Update `packages/contracts/src/index.ts` to export:

```ts
export {
  DataClassificationSchema,
  ResultRedactionRuleSchema,
  RiskSchema,
  type DataClassification,
  type ResultRedactionRule,
  type Risk,
} from "./registry/schemas.js";
export {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type ContractDefinition,
  type InferContractInput,
  type InferContractOutput,
  type QueryDefinition,
} from "./registry/definitions.js";
```

- [ ] **Step 5: Run tests and typecheck to prove GREEN**

Run:

```bash
pnpm --filter @laundry/contracts test -- test/registry.test.ts
pnpm --filter @laundry/contracts typecheck
```

Expected: tests and both production/test TypeScript configs pass.

- [ ] **Step 6: Commit complete builders**

```bash
git add packages/contracts/src packages/contracts/test/registry.test.ts
git commit -m "feat(contracts): define immutable command query contracts" \
  -m "Co-Authored-By: Codex <codex@openai.com>"
```

### Task 4: Verify package and monorepo gates

**Files:**

- Modify only if verification exposes a defect in the A1-owned files.

- [ ] **Step 1: Format A1 files**

Run:

```bash
pnpm exec prettier --write packages/contracts package.json package-lock.json pnpm-lock.yaml
```

Expected: formatting completes without touching files outside A1 scope and lockfiles.

- [ ] **Step 2: Run contracts gates from a clean cache-independent path**

Run:

```bash
pnpm --filter @laundry/contracts lint
pnpm --filter @laundry/contracts typecheck
pnpm --filter @laundry/contracts test
pnpm --filter @laundry/contracts build
```

Expected: all exit 0.

- [ ] **Step 3: Run the full V2 foundation gate**

Run:

```bash
pnpm run workspace:check
```

Expected: foundation tests and all seven workspaces' format/lint/typecheck/test/build tasks pass.

- [ ] **Step 4: Check scope, generated output, and secrets**

Run:

```bash
git diff --check origin/main...HEAD
git diff --name-only origin/main...HEAD
git status --short
rg -n "(BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|api[_-]?key|secret\s*=|password\s*=)" packages/contracts
```

Expected: only `packages/contracts/**`, `package-lock.json`, and `pnpm-lock.yaml` differ; no generated `dist` or `.turbo` files are tracked; no credentials are found.

- [ ] **Step 5: Commit any verification-only corrections**

If formatting or a defect fix changed files, commit with the required footer. Do not create an empty commit.

### Task 5: Independent review and Claude handoff

**Files:**

- No code changes unless a reviewer finds a concrete issue.

- [ ] **Step 1: Request independent spec-compliance review**

Reviewer compares the diff with `packages/contracts/docs/a1-contract-registry-design.md`, the task-book A1 row, architecture §6.5, and ADR-05. Resolve all Blocker/Important issues and re-run gates.

- [ ] **Step 2: Request TypeScript code-quality review**

Reviewer checks strict types, Zod 4 correctness, error behavior, immutable outputs, API minimality, test quality, and absence of A2/C1 scope creep. Resolve all actionable findings and re-run gates.

- [ ] **Step 3: Push and open a focused A1 PR**

```bash
git push -u origin codex/m1-a1-contract-registry
gh pr create \
  --base main \
  --head codex/m1-a1-contract-registry \
  --title "feat(contracts): 定义 A1 命令与查询注册表契约" \
  --body $'## Summary\n\n- define strict, immutable command/query contracts\n- require all six safety metadata fields\n- preserve Zod input/output inference\n- declare package-local Zod/Vitest dependencies and sync both lockfiles\n\n## Verification\n\n- pnpm --filter @laundry/contracts lint\n- pnpm --filter @laundry/contracts typecheck\n- pnpm --filter @laundry/contracts test\n- pnpm --filter @laundry/contracts build\n- pnpm run workspace:check\n\n## Review gate\n\n请 Claude 进行 A1 契约结对评审；通过前不启动 A2。'
```

PR body must include the design decisions, test evidence, dependency/lockfile changes, and an explicit request for Claude's A1 paired contract review. Stop after opening the PR; do not start A2 until Claude accepts this group.
