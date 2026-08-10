import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { fail, sha256File } from "./hk-vps-release-core.mjs";

export const MIGRATION_RUNNER_RELATIVE = "tools/compose/migrate-v2.sh";

const AUTHORITY_KEYS = Object.freeze(["migrations", "runner_sha256", "schema", "version"]);
const MIGRATION_KEYS = Object.freeze(["checksum", "filename"]);
const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const MAXIMUM_FILE_BYTES = 2 * 1024 * 1024;

function exactKeys(value, expected) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseMigrations(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) {
    fail("CLOUD_RELEASE_MIGRATION_AUTHORITY_INVALID");
  }
  let previous = "";
  return Object.freeze(
    value.map((item) => {
      if (
        !exactKeys(item, MIGRATION_KEYS) ||
        !MIGRATION_NAME.test(item.filename) ||
        !DIGEST.test(item.checksum) ||
        item.filename <= previous
      ) {
        fail("CLOUD_RELEASE_MIGRATION_AUTHORITY_INVALID");
      }
      previous = item.filename;
      return Object.freeze({ checksum: item.checksum, filename: item.filename });
    }),
  );
}

export function parseMigrationAuthority(value) {
  if (
    !exactKeys(value, AUTHORITY_KEYS) ||
    value.schema !== "laundry.cloud-release.migration-authority" ||
    value.version !== 1 ||
    !DIGEST.test(value.runner_sha256)
  ) {
    fail("CLOUD_RELEASE_MIGRATION_AUTHORITY_INVALID");
  }
  return Object.freeze({
    migrations: parseMigrations(value.migrations),
    runner_sha256: value.runner_sha256,
    schema: value.schema,
    version: value.version,
  });
}

async function assertDirectory(path, identity, dependencies) {
  const metadata = await dependencies.lstat(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== identity.uid ||
    metadata.gid !== identity.gid ||
    (metadata.mode & 0o022) !== 0 ||
    (await dependencies.realpath(path).catch(() => null)) !== path
  ) {
    fail("CLOUD_RELEASE_MIGRATION_AUTHORITY_INVALID");
  }
}

async function fileDigest(path, identity, dependencies) {
  const metadata = await dependencies.lstat(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== identity.uid ||
    metadata.gid !== identity.gid ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o022) !== 0 ||
    metadata.size < 1 ||
    metadata.size > MAXIMUM_FILE_BYTES ||
    (await dependencies.realpath(path).catch(() => null)) !== path
  ) {
    fail("CLOUD_RELEASE_MIGRATION_AUTHORITY_INVALID");
  }
  return await dependencies.sha256File(path);
}

function authorityDependencies(input = {}) {
  return Object.freeze({
    gid: input.gid ?? 0,
    lstat: input.lstat ?? lstat,
    readdir: input.readdir ?? readdir,
    realpath: input.realpath ?? realpath,
    sha256File: input.sha256File ?? sha256File,
    uid: input.uid ?? 0,
  });
}

export async function verifyMigrationAuthority(root, input, inputDependencies = {}) {
  const authority = parseMigrationAuthority(input);
  const dependencies = authorityDependencies(inputDependencies);
  const identity = Object.freeze({ gid: dependencies.gid, uid: dependencies.uid });
  const directories = [
    root,
    join(root, "tools"),
    join(root, "tools/compose"),
    join(root, "packages"),
    join(root, "packages/db"),
    join(root, "packages/db/src"),
    join(root, "packages/db/src/migrations"),
  ];
  for (const path of directories) await assertDirectory(path, identity, dependencies);

  const migrationRoot = join(root, "packages/db/src/migrations");
  const names = (await dependencies.readdir(migrationRoot, { withFileTypes: true }))
    .filter((entry) => MIGRATION_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (
    names.length !== authority.migrations.length ||
    names.some((name, index) => name !== authority.migrations[index]?.filename)
  ) {
    fail("CLOUD_RELEASE_MIGRATION_AUTHORITY_INVALID");
  }
  const runner = await fileDigest(join(root, MIGRATION_RUNNER_RELATIVE), identity, dependencies);
  if (runner !== authority.runner_sha256) fail("CLOUD_RELEASE_MIGRATION_AUTHORITY_MISMATCH");
  for (const migration of authority.migrations) {
    const digest = await fileDigest(
      join(migrationRoot, migration.filename),
      identity,
      dependencies,
    );
    if (digest !== migration.checksum) fail("CLOUD_RELEASE_MIGRATION_AUTHORITY_MISMATCH");
  }
  return authority;
}

export async function captureMigrationAuthority(root, inventory, dependencies = {}) {
  const selected = authorityDependencies(dependencies);
  const authority = parseMigrationAuthority({
    migrations: inventory,
    runner_sha256: await fileDigest(
      join(root, MIGRATION_RUNNER_RELATIVE),
      Object.freeze({ gid: selected.gid, uid: selected.uid }),
      selected,
    ),
    schema: "laundry.cloud-release.migration-authority",
    version: 1,
  });
  await verifyMigrationAuthority(root, authority, selected);
  return authority;
}
