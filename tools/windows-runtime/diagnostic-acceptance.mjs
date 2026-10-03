import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function diagnosticAcceptance({
  scenario,
  command,
  platform,
  io,
  root,
  secretDigest,
  beforeSecrets,
  digest,
}) {
  await scenario("private-redacted-diagnostic-export", async () => {
    const before = await io.read(join(root, "state.json"));
    const result = await command("diagnostics");
    assert.equal(result.status, "diagnostic_exported");
    assert.equal((await platform.inspectPrivateFile(result.path)).scheme, "windows-dacl-v1");
    const bytes = await readFile(result.path);
    assert.equal(digest(bytes), result.sha256);
    assert.equal(bytes.length, result.bytes);
    assert.ok(bytes.length < 256 * 1024);
    const text = bytes.toString("utf8");
    assert.equal(text.includes(root), false);
    const bundle = JSON.parse(text);
    assert.equal(bundle.privacy.credentials, "excluded");
    assert.equal(bundle.privacy.raw_logs, "excluded");
    assert.equal(bundle.services.data.api_port_open, true);
    assert.equal(bundle.services.data.postgres_port_open, true);
    assert.equal(bundle.backups.status, "available");
    assert.equal(await io.read(join(root, "state.json")), before);
    assert.equal(await secretDigest(), beforeSecrets);
    assert.equal((await command("status")).status, "running");
  });
}
