import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";

const MIGRATION_NAME = /^[0-9]{4}_[a-z0-9_]+\.sql$/u;

export type RuntimeMigrationEntry = Readonly<{
  filename: string;
  checksum: string;
  sql: string;
}>;

export type RuntimeMigrationBundle = Readonly<{
  entries: readonly RuntimeMigrationEntry[];
  aggregateChecksum: string;
  head: string;
}>;

const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

const invalid = (): never => {
  throw new Error("RUNTIME_MIGRATION_BUNDLE_INVALID");
};

export async function loadMigrationBundle(root: string): Promise<RuntimeMigrationBundle> {
  const names = (await readdir(root)).filter((name) => MIGRATION_NAME.test(name)).sort();
  if (names.length === 0) invalid();
  const entries: RuntimeMigrationEntry[] = [];
  for (let index = 0; index < names.length; index += 1) {
    const filename: string = names[index] ?? invalid();
    if (Number.parseInt(filename.slice(0, 4), 10) !== index + 1) invalid();
    const path = join(root, filename);
    const metadata = await lstat(path).catch(() => null);
    if (
      metadata === null ||
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size <= 0
    ) {
      invalid();
    }
    const sql = await readFile(path, "utf8");
    entries.push(Object.freeze({ filename, checksum: digest(sql), sql }));
  }
  const aggregate = entries.map((entry) => `${entry.filename}\0${entry.checksum}\n`).join("");
  return Object.freeze({
    entries: Object.freeze(entries),
    aggregateChecksum: digest(aggregate),
    head: entries.at(-1)?.filename ?? invalid(),
  });
}

type LedgerRow = Readonly<{ filename: string; checksum: string }>;

const ensureLedger = async (client: PgPoolClient): Promise<void> => {
  await client.query(`CREATE TABLE IF NOT EXISTS public.laundry_schema_migrations (
    filename text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  await client.query("REVOKE ALL ON TABLE public.laundry_schema_migrations FROM PUBLIC");
  await client.query("REVOKE ALL ON TABLE public.laundry_schema_migrations FROM laundry_app");
};

const assertLedger = (rows: readonly LedgerRow[], bundle: RuntimeMigrationBundle): void => {
  for (const row of rows) {
    const expected = bundle.entries.find((entry) => entry.filename === row.filename);
    if (expected === undefined || expected.checksum !== row.checksum) {
      throw new Error("RUNTIME_MIGRATION_LEDGER_MISMATCH");
    }
  }
};

const applyEntry = async (client: PgPoolClient, entry: RuntimeMigrationEntry): Promise<void> => {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_catalog.pg_advisory_xact_lock($1, $2)", [1279345987, 20260725]);
    const existing = await client.query<LedgerRow>(
      "SELECT filename, checksum FROM public.laundry_schema_migrations WHERE filename = $1",
      [entry.filename],
    );
    if (existing.rows[0] !== undefined) {
      if (existing.rows[0].checksum !== entry.checksum) {
        throw new Error("RUNTIME_MIGRATION_LEDGER_MISMATCH");
      }
    } else {
      if (entry.filename !== "0001_roles.sql") await client.query("SET LOCAL ROLE laundry_owner");
      await client.query(entry.sql);
      if (entry.filename !== "0001_roles.sql") await client.query("RESET ROLE");
      await client.query(
        "INSERT INTO public.laundry_schema_migrations (filename, checksum) VALUES ($1, $2)",
        [entry.filename, entry.checksum],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
};

export async function applyRuntimeMigrations(
  pool: PgPool,
  bundle: RuntimeMigrationBundle,
): Promise<void> {
  const client = await pool.connect();
  try {
    await ensureLedger(client);
    const before = await client.query<LedgerRow>(
      "SELECT filename, checksum FROM public.laundry_schema_migrations ORDER BY filename",
    );
    assertLedger(before.rows, bundle);
    for (const entry of bundle.entries) await applyEntry(client, entry);
    const after = await client.query<LedgerRow>(
      "SELECT filename, checksum FROM public.laundry_schema_migrations ORDER BY filename",
    );
    assertLedger(after.rows, bundle);
    if (after.rows.length !== bundle.entries.length) {
      throw new Error("RUNTIME_MIGRATION_LEDGER_MISMATCH");
    }
  } finally {
    client.release();
  }
}

export async function verifyRuntimeMigrationLedger(
  pool: PgPool,
  bundle: RuntimeMigrationBundle,
): Promise<void> {
  const result = await pool.query<LedgerRow>(
    "SELECT filename, checksum FROM public.laundry_schema_migrations ORDER BY filename",
  );
  assertLedger(result.rows, bundle);
  if (result.rows.length !== bundle.entries.length) {
    throw new Error("RUNTIME_MIGRATION_LEDGER_MISMATCH");
  }
}
