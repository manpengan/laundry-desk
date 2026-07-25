import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rootUrl = new URL("../../", import.meta.url);
const governanceFiles = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GROK.md",
  "GEMINI.md",
  "HERMES.md",
];
const currentDeliveryAdr = "(docs/adr/2026-07-25-adr-14-generic-local-first-v2-delivery.md)";

async function readRepositoryFile(path) {
  return readFile(new URL(path, rootUrl), "utf8");
}

test("routes every governance entry point to ADR-14", async () => {
  const contents = await Promise.all(governanceFiles.map(readRepositoryFile));
  const missingLinks = governanceFiles.filter(
    (_file, index) => !contents[index].includes(currentDeliveryAdr),
  );

  assert.deepEqual(missingLinks, []);
});

test("leads the README with the generic local Web and macOS route", async () => {
  const readmeLead = (await readRepositoryFile("README.md")).slice(0, 1500);

  assert.match(readmeLead, /通用 V2.*本地 Web.*macOS/su);
});

test("does not advertise stale Hongfa or Grok delivery ownership in the README lead", async () => {
  const readmeLead = (await readRepositoryFile("README.md")).slice(0, 1500);

  assert.doesNotMatch(readmeLead, /宏发升级候选版|Grok 单一技术负责人/u);
});

test("runs every foundation test from the default workspace test gate", async () => {
  const rootPackage = JSON.parse(await readRepositoryFile("package.json"));

  assert.equal(
    rootPackage.scripts["workspace:test"],
    "node --test tests/foundation/*.test.mjs && turbo run test",
  );
});
