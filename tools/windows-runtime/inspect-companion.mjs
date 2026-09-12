import { readFile, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, MANIFEST_NAME, parseManifest } from "./companion-contract.mjs";
import { hashFile, inventory, requireRealDirectory } from "./companion-files.mjs";

async function requireX64Pe(path) {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(64);
    if (
      (await handle.read(header, 0, 64, 0)).bytesRead !== 64 ||
      header.toString("ascii", 0, 2) !== "MZ"
    )
      fail("PE_INVALID");
    const offset = header.readUInt32LE(60);
    const pe = Buffer.alloc(26);
    if (
      offset < 64 ||
      offset > 1024 * 1024 ||
      (await handle.read(pe, 0, 26, offset)).bytesRead !== 26 ||
      pe.readUInt32LE(0) !== 0x4550 ||
      pe.readUInt16LE(4) !== 0x8664 ||
      pe.readUInt16LE(24) !== 0x20b
    )
      fail("PE_INVALID");
  } finally {
    await handle.close();
  }
}

export async function inspectCompanion(root, expectedDigest) {
  root = await requireRealDirectory(root);
  const manifestPath = join(root, MANIFEST_NAME);
  await hashFile(manifestPath);
  const bytes = await readFile(manifestPath);
  const manifest = parseManifest(bytes, expectedDigest);
  const actual = await inventory(root, [MANIFEST_NAME]);
  if (
    JSON.stringify(actual.files) !==
    JSON.stringify(manifest.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })))
  ) {
    fail("INVENTORY_MISMATCH");
  }
  if (
    actual.directories.some(
      (directory) => !actual.files.some((entry) => entry.path.startsWith(`${directory}/`)),
    )
  ) {
    fail("UNLISTED_DIRECTORY");
  }
  for (const file of actual.files.filter((entry) => /\.(exe|node)$/iu.test(entry.path))) {
    await requireX64Pe(join(root, file.path));
  }
  const helper =
    "server/node_modules/@laundry/platform-fs/native/windows/laundry-windows-helper.exe";
  const helperHash = manifest.files.find((entry) => entry.path === helper).sha256;
  if ((await readFile(join(root, `${helper}.sha256`), "utf8")) !== `${helperHash}\n`)
    fail("HELPER_DIGEST_MISMATCH");
  if (!(await readFile(manifestPath)).equals(bytes)) fail("MANIFEST_CHANGED");
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) fail("ARGS_INVALID");
    const manifest = await inspectCompanion(process.argv[2], process.argv[3]);
    console.log(
      JSON.stringify({
        status: "payload_verified",
        assurance: manifest.assurance,
        source_git_sha: manifest.source_git_sha,
        files: manifest.files.length,
      }),
    );
  } catch (error) {
    console.error(
      /^WINDOWS_COMPANION_[A-Z_]+$/u.test(error.message)
        ? error.message
        : "WINDOWS_COMPANION_INSPECTION_FAILED",
    );
    process.exitCode = 1;
  }
}
