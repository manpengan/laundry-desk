import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = join(packageRoot, "src");

test("production sources expose no default customer ticket or unsigned renderer execution", () => {
  const index = readFileSync(join(sourceRoot, "index.ts"), "utf8");
  const ipc = readFileSync(join(sourceRoot, "ipc.ts"), "utf8");
  const executor = readFileSync(join(sourceRoot, "print", "executor.ts"), "utf8");
  const combined = `${index}\n${ipc}\n${executor}`;

  assert.doesNotMatch(combined, /DEFAULT_SAMPLE_TICKET|宏发|13800138000|张三/u);
  assert.match(ipc, /renderer print execution is disabled; use signed Edge dispatch/u);
  assert.doesNotMatch(ipc, /buildPrinterSmokePayload|submitCupsBytes|executeJob\(/u);
  assert.match(executor, /ticket:\s*TicketTemplateInput/u);
});
