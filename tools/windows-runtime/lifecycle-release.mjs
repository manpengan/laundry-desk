import { cp, mkdir, open, rename, rm, readFile, unlink, rmdir, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { inspectCompanion } from "./inspect-companion.mjs";
import { inventory, requireRealDirectory } from "./companion-files.mjs";
import { MANIFEST_NAME, parseManifest, fail } from "./companion-contract.mjs";
import { exists, reference } from "./lifecycle-storage.mjs";

export async function stageRelease(root, source, expectedDigest, platform) {
  const releases = join(root, "releases");
  const target = join(releases, expectedDigest);
  if (await exists(target)) {
    const contents = await inventory(target);
    if (
      contents.files.length === 1 &&
      contents.files[0].path === MANIFEST_NAME &&
      !contents.directories.length
    ) {
      parseManifest(await readFile(join(target, MANIFEST_NAME)), expectedDigest);
      const retired = join(releases, `.uninstalled-${randomUUID()}`);
      await rename(target, retired);
      await platform.flushDirectoryDurably(releases);
      await rm(retired, { recursive: true });
    } else {
      return { payload: target, manifest: await inspectCompanion(target, expectedDigest) };
    }
  }
  const temporary = join(releases, `.staging-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  await platform.securePrivateDirectory(temporary);
  try {
    // Keep the pre-created protected root. Copy its children into absent targets;
    // Node 22 rejects cp(directory, existingDirectory) with errorOnExist enabled.
    for (const name of await readdir(source)) {
      await cp(join(source, name), join(temporary, name), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
    const manifest = await inspectCompanion(temporary, expectedDigest);
    const contents = await inventory(temporary);
    // Flush every copied byte before publishing a directory or a version pointer.
    for (const entry of contents.files) {
      const file = await open(join(temporary, entry.path), "r+");
      try {
        await file.sync();
      } finally {
        await file.close();
      }
    }
    for (const directory of [...contents.directories].sort((a, b) => b.length - a.length))
      await platform.flushDirectoryDurably(join(temporary, directory));
    await platform.flushDirectoryDurably(temporary);
    await rename(temporary, target);
    await platform.flushDirectoryDurably(releases);
    await inspectCompanion(target, expectedDigest);
    return { payload: target, manifest };
  } finally {
    if (await exists(temporary)) {
      await requireRealDirectory(temporary);
      await rm(temporary, { recursive: true });
      await platform.flushDirectoryDurably(dirname(temporary));
    }
  }
}

export async function verifyRelease(root, entry) {
  const payload = join(root, "releases", entry.digest);
  const manifest = await inspectCompanion(payload, entry.digest);
  if (JSON.stringify(reference(manifest, entry.digest)) !== JSON.stringify(entry))
    throw new Error("WINDOWS_COMPANION_RELEASE_IDENTITY_INVALID");
  return { payload, manifest };
}

// Keep the externally bound manifest as the uninstall recovery record. Each retry
// verifies the remaining subset before removing anything, including empty folders.
export async function removeBoundPrograms(root, entry, platform) {
  const payload = join(root, "releases", entry.digest);
  if (!(await exists(payload))) return;
  const manifest = parseManifest(await readFile(join(payload, MANIFEST_NAME)), entry.digest);
  if (JSON.stringify(reference(manifest, entry.digest)) !== JSON.stringify(entry))
    fail("RELEASE_IDENTITY_INVALID");
  const remaining = await inventory(payload, [MANIFEST_NAME]);
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  for (const file of remaining.files) {
    const bound = expected.get(file.path);
    if (!bound || bound.size !== file.size || bound.sha256 !== file.sha256)
      fail("UNINSTALL_CONTENT_CHANGED");
  }
  for (const directory of remaining.directories) {
    if (!manifest.files.some((file) => file.path.startsWith(`${directory}/`)))
      fail("UNINSTALL_CONTENT_CHANGED");
  }
  for (const file of remaining.files) await unlink(join(payload, file.path));
  for (const directory of remaining.directories.sort((a, b) => b.length - a.length))
    await rmdir(join(payload, directory));
  await platform.flushDirectoryDurably(payload);
}
