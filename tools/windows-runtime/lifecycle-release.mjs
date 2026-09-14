import { cp, mkdir, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { inspectCompanion } from "./inspect-companion.mjs";
import { inventory, requireRealDirectory } from "./companion-files.mjs";
import { exists, reference } from "./lifecycle-storage.mjs";

export async function stageRelease(root, source, expectedDigest, platform) {
  const releases = join(root, "releases");
  const target = join(releases, expectedDigest);
  if (await exists(target)) {
    return { payload: target, manifest: await inspectCompanion(target, expectedDigest) };
  }
  const temporary = join(releases, `.staging-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  await platform.securePrivateDirectory(temporary);
  try {
    await cp(source, temporary, { recursive: true, force: false, errorOnExist: true });
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
