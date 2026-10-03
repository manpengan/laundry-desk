import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { storage } from "./lifecycle-storage.mjs";
import { digest } from "./companion-contract.mjs";

export const release = {
  digest: "a".repeat(64),
  release: "0.1.0-win-dev",
  source: "b".repeat(40),
  migrationHead: "0069_bounded_automation.sql",
  migrations: "c".repeat(64),
};
export const platform = {
  securePrivateFile: (path) => chmod(path, 0o600),
  securePrivateDirectory: (path) => chmod(path, 0o700),
  inspectPrivateFile: async (path) => {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      (process.platform !== "win32" && (info.mode & 0o777) !== 0o600)
    )
      throw new Error("PRIVATE_FILE_INVALID");
  },
  inspectPrivateDirectory: async (path) => {
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.platform !== "win32" && (info.mode & 0o777) !== 0o700)
    )
      throw new Error("PRIVATE_DIRECTORY_INVALID");
  },
  replaceFileWriteThrough: rename,
  publishFileNoReplace: async (source, destination) => {
    await link(source, destination);
    await unlink(source);
  },
  flushDirectoryDurably: async (path) => {
    if (process.platform === "win32") return;
    const file = await open(path);
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  },
};

export async function backupFixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "laundry-backup-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const io = storage(platform);
  await mkdir(join(root, "secrets"), { mode: 0o700 });
  await io.write(join(root, "secrets/access-token-secret"), "synthetic-instance-key");
  return {
    root,
    io,
    platform,
    entry: release,
    instance: digest("synthetic-instance-key"),
    postgresVersion: "16.15",
  };
}
