import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { fail, requireMigrationHead, sha256File } from "./hk-vps-release-core.mjs";

const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

function exactKeys(value, expected) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export async function migrationInventory(root, expectedHead) {
  const directory = join(root, "packages/db/src/migrations");
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && MIGRATION_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (names.length < 1 || names.at(-1) !== requireMigrationHead(expectedHead)) {
    fail("CLOUD_RELEASE_MIGRATION_INVENTORY_INVALID");
  }
  return Object.freeze(
    await Promise.all(
      names.map(async (name) =>
        Object.freeze({ filename: name, checksum: await sha256File(join(directory, name)) }),
      ),
    ),
  );
}

export function parseMigrationLedger(source) {
  if (typeof source !== "string" || source.length > 256 * 1024) {
    fail("CLOUD_RELEASE_MIGRATION_LEDGER_INVALID");
  }
  const rows = source.trimEnd().split("\n");
  if (rows.length < 1) fail("CLOUD_RELEASE_MIGRATION_LEDGER_INVALID");
  return Object.freeze(
    rows.map((line) => {
      const [filename, checksum, extra] = line.split("\t");
      if (
        extra !== undefined ||
        !MIGRATION_NAME.test(filename ?? "") ||
        !DIGEST.test(checksum ?? "")
      ) {
        fail("CLOUD_RELEASE_MIGRATION_LEDGER_INVALID");
      }
      return Object.freeze({ filename, checksum });
    }),
  );
}

export function assertMigrationLedger(inventory, ledger, mode) {
  if (!Array.isArray(inventory) || !Array.isArray(ledger) || !["prefix", "exact"].includes(mode)) {
    fail("CLOUD_RELEASE_MIGRATION_LEDGER_INVALID");
  }
  if (
    ledger.length < 1 ||
    ledger.length > inventory.length ||
    (mode === "exact" && ledger.length !== inventory.length) ||
    ledger.some(
      (row, index) =>
        row.filename !== inventory[index]?.filename || row.checksum !== inventory[index]?.checksum,
    )
  ) {
    fail("CLOUD_RELEASE_MIGRATION_LEDGER_MISMATCH");
  }
}

export async function readCompatibilityPolicy(root) {
  const path = join(root, "tools/cloud/hk-vps-release-compatibility.json");
  const metadata = await lstat(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 2 ||
    metadata.size > 64 * 1024
  ) {
    fail("CLOUD_RELEASE_COMPATIBILITY_INVALID");
  }
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail("CLOUD_RELEASE_COMPATIBILITY_INVALID", error);
  }
  if (
    !exactKeys(value, ["transitions", "version"]) ||
    value.version !== 1 ||
    !Array.isArray(value.transitions)
  ) {
    fail("CLOUD_RELEASE_COMPATIBILITY_INVALID");
  }
  const transitions = value.transitions.map((item) => {
    if (
      !exactKeys(item, ["decision", "from_migration", "old_code_compatible", "to_migration"]) ||
      !MIGRATION_NAME.test(item.from_migration) ||
      !MIGRATION_NAME.test(item.to_migration) ||
      item.old_code_compatible !== true ||
      !/^ADR-\d+$/u.test(item.decision)
    ) {
      fail("CLOUD_RELEASE_COMPATIBILITY_INVALID");
    }
    return Object.freeze({ ...item });
  });
  const identities = new Set(
    transitions.map((item) => `${item.from_migration}\0${item.to_migration}`),
  );
  if (identities.size !== transitions.length) fail("CLOUD_RELEASE_COMPATIBILITY_INVALID");
  return Object.freeze(transitions);
}

export function resolveCompatibility(transitions, fromMigration, toMigration) {
  if (fromMigration === toMigration) {
    return Object.freeze({ compatible: true, decision: "same_migration" });
  }
  const match = transitions.find(
    (item) => item.from_migration === fromMigration && item.to_migration === toMigration,
  );
  return Object.freeze({
    compatible: match !== undefined,
    decision: match?.decision ?? "unproven",
  });
}

export function isOldCodeCompatible(transitions, fromMigration, toMigration) {
  return resolveCompatibility(transitions, fromMigration, toMigration).compatible;
}
