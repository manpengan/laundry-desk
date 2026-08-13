import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readPrivateCredential } from "./ai-provider-smoke-secret.mjs";

test("provider smoke accepts one final LF or CRLF", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-provider-smoke-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, suffix] of [
    ["plain", ""],
    ["lf", "\n"],
    ["crlf", "\r\n"],
  ]) {
    const path = join(root, name);
    await writeFile(path, `safe-provider-key-1234${suffix}`, { mode: 0o600 });
    const credential = readPrivateCredential(path);
    assert.equal(credential.toString("ascii"), "safe-provider-key-1234");
    credential.fill(0);
  }
});

test("provider smoke rejects links, broad permissions, and internal newlines", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-provider-smoke-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const regular = join(root, "regular");
  const linked = join(root, "linked");
  const broad = join(root, "broad");
  const invalid = join(root, "invalid");
  await writeFile(regular, "safe-provider-key-1234", { mode: 0o600 });
  await symlink(regular, linked);
  await writeFile(broad, "safe-provider-key-1234", { mode: 0o644 });
  await writeFile(invalid, "safe-provider\nkey\n", { mode: 0o600 });
  for (const path of [linked, broad, invalid]) {
    assert.throws(() => readPrivateCredential(path), /SMOKE_CREDENTIAL_FILE_INVALID/u);
  }
});
