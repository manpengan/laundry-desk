import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ESLint } from "eslint";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const eslint = new ESLint({ cwd: repositoryRoot });
const frozenProductionBudgets = Object.freeze([
  Object.freeze(["apps/edge-agent/src/desktop/http-transport.ts", 799]),
  Object.freeze(["apps/edge-agent/scripts/sync-spa.mjs", 687]),
  Object.freeze(["apps/server/src/local/bootstrap.ts", 795]),
  Object.freeze(["apps/server/src/identity/pg-store.ts", 773]),
  Object.freeze(["apps/server/src/http/login-rate-limit.ts", 632]),
  Object.freeze(["apps/server/src/order/pg-order-store.ts", 506]),
  Object.freeze(["apps/server/src/identity/memory-store.ts", 481]),
  Object.freeze(["apps/server/src/local/create-runtime.ts", 457]),
  Object.freeze(["apps/server/src/identity/pg-pin-repo.ts", 456]),
  Object.freeze(["apps/server/src/identity/session.ts", 418]),
  Object.freeze(["apps/web/src/host/desktop-ports.ts", 671]),
  Object.freeze(["apps/web/src/auth/HttpAuthClient.ts", 534]),
  Object.freeze(["apps/web/src/pages/ReceivePage.tsx", 411]),
  Object.freeze(["packages/contracts/src/auth/pin.ts", 549]),
  Object.freeze(["packages/contracts/src/index.ts", 533]),
  Object.freeze(["tools/local/config.mjs", 474]),
]);

function sourceWithPhysicalLines(lineCount) {
  return Array.from({ length: lineCount }, (_, index) => `// line ${index + 1}`).join("\n");
}

async function maxLineMessages(filePath, lineCount) {
  const [result] = await eslint.lintText(sourceWithPhysicalLines(lineCount), { filePath });
  return result.messages.filter(({ ruleId }) => ruleId === "max-lines");
}

function maxLinesFrom(config) {
  const normalizedRule = config?.rules?.["max-lines"];
  if (!Array.isArray(normalizedRule)) return undefined;

  const options = normalizedRule[1];
  if (typeof options === "number") return options;
  if (options !== null && typeof options === "object" && typeof options.max === "number") {
    return options.max;
  }
  return undefined;
}

test("enforces 400 production lines and 800 test lines", async () => {
  assert.equal((await maxLineMessages("apps/server/src/file-size-probe.ts", 400)).length, 0);
  assert.equal((await maxLineMessages("apps/server/src/file-size-probe.ts", 401)).length, 1);
  assert.equal((await maxLineMessages("apps/server/src/file-size-probe.test.ts", 800)).length, 0);
  assert.equal((await maxLineMessages("apps/server/src/file-size-probe.test.ts", 801)).length, 1);
});

test("resolves exact frozen production budgets", async () => {
  assert.equal(frozenProductionBudgets.length, 16);

  for (const [filePath, expectedMaxLines] of frozenProductionBudgets) {
    const config = await eslint.calculateConfigForFile(filePath);
    assert.equal(maxLinesFrom(config), expectedMaxLines, filePath);
  }
});

test("scopes root production and test budgets to active local-first files", async () => {
  const rootSourceConfig = await eslint.calculateConfigForFile("src/main.ts");
  assert.equal(rootSourceConfig.rules["max-lines"], undefined);
  assert.equal(maxLinesFrom(await eslint.calculateConfigForFile("tools/local/probe.mjs")), 400);

  for (const testPath of [
    "tools/local/probe.test.mjs",
    "tools/local/probe.spec.mjs",
    "tools/local/test/probe.mjs",
    "tools/local/tests/probe.mjs",
    "tools/local/__tests__/probe.mjs",
    "tools/local/e2e/probe.mjs",
  ]) {
    assert.equal(maxLinesFrom(await eslint.calculateConfigForFile(testPath)), 800, testPath);
  }

  assert.equal(
    maxLinesFrom(await eslint.calculateConfigForFile("tests/foundation/probe.test.mjs")),
    800,
  );
});
