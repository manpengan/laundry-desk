import { randomUUID } from "node:crypto";
import { opendir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { digest, fail } from "./companion-contract.mjs";
import { collectDiagnosticBundle } from "./diagnostic-bundle.mjs";

export const MAX_DIAGNOSTIC_BYTES = 256 * 1024;
export const MAX_DIAGNOSTIC_EXPORTS = 32;
const NAME = /^d_[a-f0-9]{32}\.json$/u;

async function requireExportDirectory(context) {
  const directory = join(context.root, "diagnostics");
  await context.io.directory(directory);
  let count = 0;
  for await (const entry of await opendir(directory)) {
    if (!NAME.test(entry.name)) fail("DIAGNOSTIC_DIRECTORY_INVALID");
    await context.platform.inspectPrivateFile(join(directory, entry.name));
    if (++count >= MAX_DIAGNOSTIC_EXPORTS) fail("DIAGNOSTIC_RETENTION_FULL");
  }
  return directory;
}

export async function exportDiagnosticBundle(context) {
  const bundle = await collectDiagnosticBundle(context);
  const bytes = Buffer.from(JSON.stringify(bundle, null, 2) + "\n", "utf8");
  if (bytes.length > MAX_DIAGNOSTIC_BYTES) fail("DIAGNOSTIC_TOO_LARGE");
  const directory = await requireExportDirectory(context);
  const file = join(directory, `d_${randomUUID().replaceAll("-", "")}.json`);
  const handle = await open(file, "wx", 0o600);
  try {
    await context.platform.securePrivateFile(file);
    await context.platform.inspectPrivateFile(file);
    await handle.writeFile(bytes);
    await handle.sync();
    await context.platform.inspectPrivateFile(file);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size !== bytes.length)
      fail("DIAGNOSTIC_FILE_CHANGED");
  } catch (error) {
    await handle.close();
    await unlink(file);
    throw error;
  }
  await handle.close();
  await context.platform.flushDirectoryDurably(directory);
  return {
    status: "diagnostic_exported",
    assurance: "development_only",
    path: file,
    sha256: digest(bytes),
    bytes: bytes.length,
    privacy: bundle.privacy.policy,
  };
}
