import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJsonUrl = new URL("../package.json", import.meta.url);
const turboJsonUrl = new URL("../../../turbo.json", import.meta.url);

test("SPA verification builds the Web app with its workspace dependencies", async () => {
  const packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8"));
  const turboJson = JSON.parse(await readFile(turboJsonUrl, "utf8"));

  assert.match(packageJson.scripts.test, /^pnpm run spa:verify\b/u);
  assert.equal(
    packageJson.scripts["spa:verify"],
    "pnpm exec turbo run build --filter=@laundry/web && pnpm run spa:check",
  );
  assert.ok(turboJson.tasks["@laundry/edge-agent#test"].dependsOn.includes("@laundry/web#test"));
});
