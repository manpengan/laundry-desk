import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const HOST_ENTRY_URL = new URL("../../host/main.tsx", import.meta.url);

async function readHostEntry(): Promise<string> {
  return readFile(HOST_ENTRY_URL, "utf8");
}

test("host entry imports the complete shared UI stylesheet stack", async () => {
  const source = await readHostEntry();

  assert.match(source, /import\s+["']@laundry\/ui\/styles\.css["'];/u);
  assert.match(source, /import\s+["']@laundry\/ui\/styles\/components\.css["'];/u);
  assert.match(source, /import\s+["']\.\.\/src\/styles\/shell\.css["'];/u);
});

test("host entry delegates selection and gates App behind ServiceGate", async () => {
  const source = await readHostEntry();

  assert.match(source, /import\s+\{\s*selectHost\s*\}\s+from\s+["'][^"']+select-ports\.js["'];/u);
  assert.doesNotMatch(source, /location\.protocol/u);
  assert.match(
    source,
    /<ServiceGate\s+health=\{ports\.health\}>[\s\S]*<App\s+ports=\{ports\}[\s\S]*<\/ServiceGate>/u,
  );
});
