import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import { loadOrCreateDeviceId } from "./device-identity.js";

const DEVICE_ID = "00000000-0000-4000-8000-000000000001";
let temporaryDirectories: readonly string[] = [];

async function createUserDataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "laundry-device-identity-"));
  temporaryDirectories = Object.freeze([...temporaryDirectories, directory]);
  await chmod(directory, 0o700);
  return directory;
}

async function createIdentityDirectory(userDataPath: string): Promise<string> {
  const directory = join(userDataPath, "device-identity");
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  return directory;
}

async function writePrivateFile(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function createInterruptedInstall(userDataPath: string, stagingName: string) {
  const identityDirectory = await createIdentityDirectory(userDataPath);
  const stagingDirectory = join(identityDirectory, stagingName);
  const candidateFile = join(stagingDirectory, "candidate");
  const identityFile = join(identityDirectory, "device-id");
  await mkdir(stagingDirectory, { mode: 0o700 });
  await chmod(stagingDirectory, 0o700);
  await writePrivateFile(candidateFile, DEVICE_ID);
  await link(candidateFile, identityFile);
  return Object.freeze({
    identityDirectory,
    stagingDirectory,
    candidateFile,
    identityFile,
  });
}

async function assertPathNotFound(path: string): Promise<void> {
  await assert.rejects(
    () => lstat(path),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT",
  );
}

test.afterEach(async () => {
  const directoriesToRemove = temporaryDirectories;
  temporaryDirectories = Object.freeze([]);
  await Promise.all(
    directoriesToRemove.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("creates one private device id and returns it on later loads", async () => {
  const userDataPath = await createUserDataDirectory();
  let generated = 0;
  const options = Object.freeze({
    userDataPath,
    randomUUID: () => {
      generated += 1;
      return DEVICE_ID;
    },
  });

  assert.equal(await loadOrCreateDeviceId(options), DEVICE_ID);
  assert.equal(await loadOrCreateDeviceId(options), DEVICE_ID);
  assert.equal(generated, 1);

  const identityDirectory = join(userDataPath, "device-identity");
  const identityFile = join(identityDirectory, "device-id");
  const directoryStat = await lstat(identityDirectory);
  const fileStat = await lstat(identityFile);
  assert.equal(directoryStat.isDirectory(), true);
  assert.equal(directoryStat.mode & 0o777, 0o700);
  assert.equal(fileStat.isFile(), true);
  assert.equal(fileStat.nlink, 1);
  assert.equal(fileStat.mode & 0o777, 0o600);
  assert.equal(await readFile(identityFile, "utf8"), DEVICE_ID);
});

test("rejects a relative userData path", async () => {
  const userDataPath = await createUserDataDirectory();

  await assert.rejects(
    () =>
      loadOrCreateDeviceId({
        userDataPath: relative(process.cwd(), userDataPath),
        randomUUID: () => DEVICE_ID,
      }),
    /absolute/u,
  );
});

test("rejects a symlinked device identity directory", async () => {
  const userDataPath = await createUserDataDirectory();
  const symlinkTarget = await createUserDataDirectory();
  await symlink(symlinkTarget, join(userDataPath, "device-identity"));

  await assert.rejects(
    () => loadOrCreateDeviceId({ userDataPath, randomUUID: () => DEVICE_ID }),
    /directory is not secure/u,
  );
});

test("rejects an identity directory with group or other permissions", async () => {
  const userDataPath = await createUserDataDirectory();
  const identityDirectory = join(userDataPath, "device-identity");
  await mkdir(identityDirectory, { mode: 0o755 });

  await assert.rejects(
    () => loadOrCreateDeviceId({ userDataPath, randomUUID: () => DEVICE_ID }),
    /directory is not secure/u,
  );
});

test("rejects a symlinked device identity file", async () => {
  const userDataPath = await createUserDataDirectory();
  const identityDirectory = await createIdentityDirectory(userDataPath);
  const symlinkTarget = join(userDataPath, "symlink-target");
  await writePrivateFile(symlinkTarget, DEVICE_ID);
  await symlink(symlinkTarget, join(identityDirectory, "device-id"));

  await assert.rejects(
    () => loadOrCreateDeviceId({ userDataPath, randomUUID: () => DEVICE_ID }),
    /file is not secure/u,
  );
});

test("rejects a device identity file with group or other permissions", async () => {
  const userDataPath = await createUserDataDirectory();
  const identityDirectory = await createIdentityDirectory(userDataPath);
  const identityFile = join(identityDirectory, "device-id");
  await writePrivateFile(identityFile, DEVICE_ID);
  await chmod(identityFile, 0o640);

  await assert.rejects(
    () => loadOrCreateDeviceId({ userDataPath, randomUUID: () => DEVICE_ID }),
    /file is not secure/u,
  );
});

test("rejects a hard-linked device identity file", async () => {
  const userDataPath = await createUserDataDirectory();
  const identityDirectory = await createIdentityDirectory(userDataPath);
  const sourceFile = join(userDataPath, "hard-link-source");
  await writePrivateFile(sourceFile, DEVICE_ID);
  await link(sourceFile, join(identityDirectory, "device-id"));

  await assert.rejects(
    () => loadOrCreateDeviceId({ userDataPath, randomUUID: () => DEVICE_ID }),
    /file is not secure/u,
  );
  assert.equal((await lstat(sourceFile)).nlink, 2);
  assert.equal((await lstat(join(identityDirectory, "device-id"))).nlink, 2);
  assert.equal(await readFile(sourceFile, "utf8"), DEVICE_ID);
});

test("rejects an oversized stored identity without echoing its contents", async () => {
  const userDataPath = await createUserDataDirectory();
  const identityDirectory = await createIdentityDirectory(userDataPath);
  const sensitiveContents = `${DEVICE_ID}-must-not-leak`;
  await writePrivateFile(join(identityDirectory, "device-id"), sensitiveContents);

  let caught: unknown;
  try {
    await loadOrCreateDeviceId({ userDataPath, randomUUID: () => DEVICE_ID });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.match(caught.message, /stored device identity is invalid/iu);
  assert.equal(caught.message.includes(sensitiveContents), false);
});

test("rejects a non-UUID stored identity without echoing its contents", async () => {
  const userDataPath = await createUserDataDirectory();
  const identityDirectory = await createIdentityDirectory(userDataPath);
  const sensitiveContents = "sensitive-invalid-device-id".padEnd(36, "x");
  await writePrivateFile(join(identityDirectory, "device-id"), sensitiveContents);

  let caught: unknown;
  try {
    await loadOrCreateDeviceId({ userDataPath, randomUUID: () => DEVICE_ID });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.match(caught.message, /stored device identity is invalid/iu);
  assert.equal(caught.message.includes(sensitiveContents), false);
});

test("rejects a generated non-UUID without persisting or echoing it", async () => {
  const userDataPath = await createUserDataDirectory();
  const sensitiveContents = "sensitive-generated-device-id".padEnd(36, "x");

  let caught: unknown;
  try {
    await loadOrCreateDeviceId({
      userDataPath,
      randomUUID: () => sensitiveContents,
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.match(caught.message, /generated device identity is invalid/iu);
  assert.equal(caught.message.includes(sensitiveContents), false);

  const identityFile = join(userDataPath, "device-identity", "device-id");
  await assertPathNotFound(identityFile);
});

test("recovers the exact managed hard-link residue of an interrupted install", async () => {
  const userDataPath = await createUserDataDirectory();
  const residue = await createInterruptedInstall(userDataPath, ".device-id-Ab12Z9");
  const unknownFile = join(residue.identityDirectory, "keep-me");
  await writePrivateFile(unknownFile, "unrelated");
  const beforeCandidate = await lstat(residue.candidateFile);
  const beforeIdentity = await lstat(residue.identityFile);
  assert.equal(beforeCandidate.ino, beforeIdentity.ino);
  assert.equal(beforeIdentity.nlink, 2);

  assert.equal(await loadOrCreateDeviceId({ userDataPath, randomUUID: () => "unused" }), DEVICE_ID);

  const recovered = await lstat(residue.identityFile);
  assert.equal(recovered.isFile(), true);
  assert.equal(recovered.nlink, 1);
  assert.equal(recovered.mode & 0o777, 0o600);
  assert.equal(await readFile(residue.identityFile, "utf8"), DEVICE_ID);
  assert.equal(await readFile(unknownFile, "utf8"), "unrelated");
  await assertPathNotFound(residue.stagingDirectory);
});

test("does not clean a managed-looking staging directory with unknown contents", async () => {
  const userDataPath = await createUserDataDirectory();
  const residue = await createInterruptedInstall(userDataPath, ".device-id-Cd34X8");
  const unknownFile = join(residue.stagingDirectory, "unknown");
  await writePrivateFile(unknownFile, "do-not-delete");

  await assert.rejects(
    () => loadOrCreateDeviceId({ userDataPath, randomUUID: () => DEVICE_ID }),
    /file is not secure/u,
  );

  assert.equal((await lstat(residue.identityFile)).nlink, 2);
  assert.equal((await lstat(residue.candidateFile)).nlink, 2);
  assert.equal(await readFile(unknownFile, "utf8"), "do-not-delete");
});

test("does not clean a hard link under an unrecognized staging name", async () => {
  const userDataPath = await createUserDataDirectory();
  const residue = await createInterruptedInstall(userDataPath, ".device-id-not-managed");

  await assert.rejects(
    () => loadOrCreateDeviceId({ userDataPath, randomUUID: () => DEVICE_ID }),
    /file is not secure/u,
  );

  assert.equal((await lstat(residue.identityFile)).nlink, 2);
  assert.equal((await lstat(residue.candidateFile)).nlink, 2);
  assert.equal(await readFile(residue.candidateFile, "utf8"), DEVICE_ID);
});

test("concurrent first loads atomically converge on one device id", async () => {
  const candidates = Array.from(
    { length: 32 },
    (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
  );

  for (let round = 0; round < 40; round += 1) {
    const userDataPath = await createUserDataDirectory();
    const loaded = await Promise.all(
      candidates.map((candidate) =>
        loadOrCreateDeviceId({
          userDataPath,
          randomUUID: () => candidate,
        }),
      ),
    );

    assert.equal(new Set(loaded).size, 1, `round ${round}`);
    assert.equal(candidates.includes(loaded[0] ?? ""), true);
    const identityFile = join(userDataPath, "device-identity", "device-id");
    const fileStat = await lstat(identityFile);
    assert.equal(fileStat.isFile(), true);
    assert.equal(fileStat.nlink, 1);
    assert.equal(fileStat.mode & 0o777, 0o600);
    assert.equal(await readFile(identityFile, "utf8"), loaded[0]);
  }
});

test("forces exact private modes under a restrictive process umask", async () => {
  const userDataPath = await createUserDataDirectory();
  const previousUmask = process.umask(0o777);
  try {
    assert.equal(
      await loadOrCreateDeviceId({ userDataPath, randomUUID: () => DEVICE_ID }),
      DEVICE_ID,
    );
  } finally {
    process.umask(previousUmask);
  }

  const identityDirectory = join(userDataPath, "device-identity");
  const identityFile = join(identityDirectory, "device-id");
  assert.equal((await lstat(identityDirectory)).mode & 0o777, 0o700);
  assert.equal((await lstat(identityFile)).mode & 0o777, 0o600);
});
