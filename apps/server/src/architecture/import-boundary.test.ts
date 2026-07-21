import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { findForbiddenImports, isBusOnlyPath, scanImportBoundary } from "./import-boundary.js";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("isBusOnlyPath matches routes/ai/worker prefixes", () => {
  assert.equal(isBusOnlyPath("routes/orders.ts"), true);
  assert.equal(isBusOnlyPath("ai/tools/cancel.ts"), true);
  assert.equal(isBusOnlyPath("worker/jobs/replay.ts"), true);
  assert.equal(isBusOnlyPath("workers/outbox.ts"), true);
  assert.equal(isBusOnlyPath("bus/executor.ts"), false);
  assert.equal(isBusOnlyPath("services/order-write.ts"), false);
});

test("findForbiddenImports flags direct write service imports", () => {
  const dirty = `
import { executeCommand } from "../bus/executor.js";
import { writeOrder } from "../services/order-write.js";
import { OrderRepo } from "../repos/orders.js";
`;
  const violations = findForbiddenImports(dirty, "routes/orders.ts");
  assert.ok(violations.length >= 2);
  assert.ok(violations.some((v) => v.snippet.includes("order-write")));
  assert.ok(violations.some((v) => v.snippet.includes("repos/orders")));
});

test("findForbiddenImports allows bus-only imports", () => {
  const clean = `
import { executeCommand } from "../bus/executor.js";
import type { CommandResult } from "../bus/types.js";
import { createCommandError } from "@laundry/contracts";
`;
  assert.deepEqual(findForbiddenImports(clean), []);
});

test("scanImportBoundary on server src is clean (no routes yet)", () => {
  const result = scanImportBoundary(srcRoot);
  assert.equal(result.ok, true);
});
