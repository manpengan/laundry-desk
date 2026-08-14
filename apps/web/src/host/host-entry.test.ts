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

test("host entry delegates selection and gates lazy surfaces behind ServiceGate", async () => {
  const source = await readHostEntry();

  assert.match(source, /import\s+\{\s*selectHost\s*\}\s+from\s+["'][^"']+select-ports\.js["'];/u);
  assert.doesNotMatch(source, /import\s+\{\s*App\s*\}/u);
  assert.doesNotMatch(source, /import\s+\{\s*CustomerPortalApp\s*\}/u);
  assert.doesNotMatch(source, /location\.protocol/u);
  assert.match(
    source,
    /<ServiceGate\s+health=\{ports\.health\}>[\s\S]*<SurfaceApp\s+ports=\{ports\}[\s\S]*<\/ServiceGate>/u,
  );
  const resumeAt = source.indexOf("await ports.resume?.resume()");
  const surfaceLoadAt = source.indexOf("await loadStaffSurfaceApp(surface)");
  const renderAt = source.lastIndexOf("createRoot(hostRoot).render");
  assert.ok(resumeAt >= 0 && surfaceLoadAt > resumeAt && renderAt > surfaceLoadAt);
  assert.match(source, /initialSession=\{resumed\.ok\s*\?\s*resumed\.session\s*:\s*null\}/u);
  assert.match(source, /readOnly=\{readOnly\}/u);
  assert.match(
    source,
    /surface === ["']customer["'][\s\S]*await import\(["'][^"']+CustomerSurfaceApp\.js["']\)[\s\S]*<CustomerSurfaceApp\s+apiBaseUrl=\{apiBaseUrl\}/u,
  );
});
