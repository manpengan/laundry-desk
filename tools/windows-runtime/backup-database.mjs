import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fail } from "./companion-contract.mjs";
import { kit } from "./lifecycle-database.mjs";
import { run } from "./lifecycle-process.mjs";
import { streamPostgres } from "./backup-process.mjs";
import { backupSpace, withBackupDump } from "./backup-files.mjs";
import { MAX_BACKUPS } from "./backup-contract.mjs";
import { MAX_PHOTOS, requirePhotoEntry } from "./backup-photo-contract.mjs";
import { verifyPhotoReferences } from "./backup-photo-files.mjs";

const CONNECTION = ["--host=127.0.0.1", "--port=8543", "--username=postgres", "--no-password"];
const DATABASE = /^(?:laundry_v2|postgres|laundry_(?:restore|previous)_[a-f0-9]{32})$/u;
const TABLES = [
  "orders",
  "customers",
  "garment_photos",
  "delivery_tasks",
  "ai_model_registry",
  "ai_approval_requests",
  "automation_policies",
];

export function databaseTools(context, dependencies = {}) {
  const { root, payload, env, io, platform } = context;
  const execute = dependencies.run ?? run;
  const stream = dependencies.stream ?? streamPostgres;
  const verifyKit = dependencies.kit ?? kit;
  async function sql(database, statement) {
    if (!DATABASE.test(database)) fail("BACKUP_DATABASE_INVALID");
    return execute(
      join(payload, "postgres/bin/psql.exe"),
      [
        ...CONNECTION,
        `--dbname=${database}`,
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--set=ON_ERROR_STOP=1",
        "--command",
        statement,
      ],
      env,
      root,
    );
  }
  async function oid(name) {
    if (!DATABASE.test(name)) fail("BACKUP_DATABASE_INVALID");
    const value = await sql(
      "postgres",
      `SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname = '${name}'`,
    );
    if (value === "") return null;
    if (!/^[0-9]+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
      fail("BACKUP_DATABASE_IDENTITY_INVALID");
    return Number(value);
  }
  async function photoRows(name) {
    const projection =
      "SELECT storage_key AS key, byte_size AS size, content_sha256 AS sha256 FROM public.garment_photos UNION ALL SELECT storage_key AS key, byte_size AS size, content_sha256 AS sha256 FROM public.delivery_evidence_attachments";
    const count = await sql(name, `SELECT count(*) FROM (${projection}) photo_refs`);
    if (!/^[0-9]+$/u.test(count) || Number(count) > MAX_PHOTOS) fail("BACKUP_PHOTO_QUOTA_EXCEEDED");
    const rows = [];
    for (let offset = 0; offset < Number(count); offset += 100) {
      const text = await sql(
        name,
        `SELECT COALESCE(json_agg(p), '[]'::json)::text FROM (SELECT * FROM (${projection}) photo_refs ORDER BY key LIMIT 100 OFFSET ${offset}) p`,
      );
      let batch;
      try {
        batch = JSON.parse(text);
      } catch {
        fail("BACKUP_PHOTO_REFERENCE_INVALID");
      }
      if (!Array.isArray(batch) || batch.length !== Math.min(100, Number(count) - offset))
        fail("BACKUP_PHOTO_REFERENCE_INVALID");
      rows.push(...batch.map(requirePhotoEntry));
    }
    return rows;
  }
  async function verify(name = "laundry_v2", expectedPhotos) {
    if (!DATABASE.test(name) || name === "postgres") fail("BACKUP_DATABASE_INVALID");
    let selected = env;
    if (name !== "laundry_v2") {
      const directory = join(root, "maintenance-secrets");
      await io.directory(directory);
      selected = { ...env };
      for (const key of ["DATABASE_ADMIN_URL", "DATABASE_URL"]) {
        const url = new URL(await io.read(env[`${key}_FILE`]));
        url.pathname = `/${name}`;
        const path = join(directory, key.toLowerCase());
        await io.write(path, url.href);
        selected[`${key}_FILE`] = path;
      }
    }
    // Verify the raw restored ledger; migration must never repair a deficient dump.
    await verifyKit(payload, "verify", selected, root);
    const tables = TABLES.map((table) => `to_regclass('public.${table}') IS NOT NULL`).join(
      " AND ",
    );
    if ((await sql(name, `SELECT CASE WHEN ${tables} THEN 'OK' ELSE 'INVALID' END`)) !== "OK")
      fail("BACKUP_TABLES_INVALID");
    await verifyPhotoReferences(context, await photoRows(name), expectedPhotos);
  }
  async function space() {
    const bytes = await sql("postgres", "SELECT pg_database_size('laundry_v2')::text");
    if (!/^[0-9]+$/u.test(bytes)) fail("BACKUP_DATABASE_SIZE_INVALID");
    await backupSpace(root, Number(bytes));
  }
  async function dump(file) {
    await stream(
      join(payload, "postgres/bin/pg_dump.exe"),
      [...CONNECTION, "--dbname=laundry_v2", "--format=custom"],
      env,
      root,
      { output: file },
    );
  }
  async function candidate() {
    const retained = await sql(
      "postgres",
      "SELECT count(*) FROM pg_catalog.pg_database WHERE datname LIKE 'laundry_restore_%' OR datname LIKE 'laundry_previous_%'",
    );
    if (!/^[0-9]+$/u.test(retained) || Number(retained) >= MAX_BACKUPS)
      fail("BACKUP_DATABASE_RETENTION_FULL");
    const suffix = randomUUID().replaceAll("-", "");
    const original = await oid("laundry_v2");
    if (!original) fail("BACKUP_DATABASE_IDENTITY_INVALID");
    return {
      name: `laundry_restore_${suffix}`,
      previous: `laundry_previous_${suffix}`,
      original_oid: original,
      restored_oid: null,
    };
  }
  async function create(value) {
    if ((await oid(value.name)) || (await oid(value.previous))) fail("BACKUP_DATABASE_CONFLICT");
    await sql(
      "postgres",
      `CREATE DATABASE ${value.name} WITH TEMPLATE template0 OWNER laundry_owner ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`,
    );
    await sql(
      "postgres",
      `COMMENT ON DATABASE ${value.name} IS '${value.name}'; REVOKE CREATE, TEMPORARY ON DATABASE ${value.name} FROM PUBLIC, laundry_app; GRANT CONNECT ON DATABASE ${value.name} TO laundry_app`,
    );
    return { ...value, restored_oid: await oid(value.name) };
  }
  async function restore(value, backup) {
    await withBackupDump(backup.path, platform, backup.manifest.database, async (file) => {
      await stream(
        join(payload, "postgres/bin/pg_restore.exe"),
        [
          ...CONNECTION,
          `--dbname=${value.name}`,
          "--format=custom",
          "--single-transaction",
          "--exit-on-error",
        ],
        env,
        root,
        { input: file },
      );
    });
    await verify(value.name, backup.photos);
  }
  async function assertLayout(value, swapped) {
    const current = await oid("laundry_v2");
    const shadow = await oid(value.name);
    const previous = await oid(value.previous);
    if (
      swapped
        ? current !== value.restored_oid || previous !== value.original_oid || shadow !== null
        : current !== value.original_oid || shadow !== value.restored_oid || previous !== null
    )
      fail("BACKUP_DATABASE_IDENTITY_INVALID");
  }
  async function swap(value, inverse = false) {
    await assertLayout(value, inverse);
    // Both renames commit together. OIDs let recovery resolve a lost commit acknowledgement.
    const statements = inverse
      ? `ALTER DATABASE laundry_v2 RENAME TO ${value.name}; ALTER DATABASE ${value.previous} RENAME TO laundry_v2;`
      : `ALTER DATABASE laundry_v2 RENAME TO ${value.previous}; ALTER DATABASE ${value.name} RENAME TO laundry_v2;`;
    await sql("postgres", `BEGIN; SET LOCAL lock_timeout = '5s'; ${statements} COMMIT;`);
    await assertLayout(value, !inverse);
  }
  async function drop(name, expected) {
    const actual = await oid(name);
    if (actual === null) return;
    if (!expected || actual !== expected) fail("BACKUP_DATABASE_IDENTITY_INVALID");
    await sql("postgres", `DROP DATABASE ${name}`);
  }
  async function recover(value) {
    if (!value) return { retained_shadow: false };
    const active = await oid("laundry_v2");
    if (value.restored_oid !== null && active === value.restored_oid) await swap(value, true);
    else if (active !== value.original_oid || (await oid(value.previous)) !== null)
      fail("BACKUP_DATABASE_IDENTITY_INVALID");
    const staged = await oid(value.name);
    if (staged !== null && value.restored_oid === null) {
      const marker = await sql(
        "postgres",
        `SELECT pg_catalog.shobj_description(oid, 'pg_database') FROM pg_catalog.pg_database WHERE datname = '${value.name}'`,
      );
      // Creation could have taken effect before its acknowledgement/marker. Never drop unbound data.
      if (marker !== value.name) return { retained_shadow: true };
    }
    await drop(value.name, value.restored_oid ?? staged);
    return { retained_shadow: false };
  }
  async function finish(value) {
    if ((await oid("laundry_v2")) !== value.restored_oid || (await oid(value.name)) !== null)
      fail("BACKUP_DATABASE_IDENTITY_INVALID");
    await verify();
    await drop(value.previous, value.original_oid);
  }
  return { sql, oid, verify, space, dump, candidate, create, restore, swap, drop, recover, finish };
}
