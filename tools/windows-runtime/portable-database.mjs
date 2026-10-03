import { createHash } from "node:crypto";
import { fail } from "./companion-contract.mjs";
import {
  discoverPortableSchema,
  identifier,
  MAX_PORTABLE_DATABASE_BYTES,
  MAX_PORTABLE_ROW_BYTES,
  PORTABLE_LEDGER_TABLE,
  requirePortableRow,
  requirePortableInventory,
  schemaFingerprint,
} from "./portable-schema.mjs";
import { OMIT_PORTABLE_TABLE_DATA, resetPortableAuthority } from "./portable-authority.mjs";

export async function exportPortableDatabase(client, output, migrations) {
  let schema;
  const hash = createHash("sha256");
  let size = 0;
  const counts = {};
  const sequences = {};
  const write = async (value) => {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    size += bytes.length;
    if (bytes.length > MAX_PORTABLE_ROW_BYTES || size > MAX_PORTABLE_DATABASE_BYTES)
      fail("PORTABLE_DATABASE_TOO_LARGE");
    await output.writeFile(bytes);
    hash.update(bytes);
  };
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    schema = await discoverPortableSchema(client);
    const ledger = await client.query(
      "SELECT filename, checksum FROM public.laundry_schema_migrations",
    );
    if (ledgerDigest(ledger.rows.map((r) => [r.filename, r.checksum])) !== migrations)
      fail("PORTABLE_MIGRATIONS_MISMATCH");
    await client.query(
      "SET LOCAL TimeZone = 'UTC'; SET LOCAL DateStyle = 'ISO, YMD'; SET LOCAL bytea_output = 'hex'",
    );
    await write({
      version: 1,
      schema_sha256: schemaFingerprint(schema),
      migrations_sha256: migrations,
    });
    for (const table of schema) {
      await write({ table: table.name });
      if (OMIT_PORTABLE_TABLE_DATA.has(table.name)) {
        counts[table.name] = 0;
        await write(null);
        continue;
      }
      const fields = table.columns.map((c) => `${identifier(c.name)}::text`).join(",");
      await client.query(
        `DECLARE portable_rows NO SCROLL CURSOR FOR SELECT json_build_array(${fields})::text AS row FROM public.${identifier(table.name)}`,
      );
      let count = 0;
      while (true) {
        const { rows } = await client.query("FETCH FORWARD 64 FROM portable_rows");
        if (rows.length === 0) break;
        for (const row of rows) {
          await write(requirePortableRow(JSON.parse(row.row), table));
          count++;
          if (count > 5_000_000) fail("PORTABLE_DATABASE_TOO_LARGE");
        }
      }
      await client.query("CLOSE portable_rows");
      counts[table.name] = count;
      await write(null);
      for (const sequence of table.sequences) {
        const { rows } = await client.query(
          `SELECT last_value::text AS value, is_called AS called FROM public.${identifier(sequence.name)}`,
        );
        sequences[sequence.name] = rows[0];
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  await output.sync();
  return requirePortableInventory({ schema, counts, sequences, size, sha256: hash.digest("hex") });
}

export async function* portableLines(input) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = Buffer.alloc(64 * 1024);
  let pending = Buffer.alloc(0);
  let position = 0;
  while (true) {
    const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    position += bytesRead;
    if (position > MAX_PORTABLE_DATABASE_BYTES) fail("PORTABLE_DATABASE_TOO_LARGE");
    pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
    let newline;
    while ((newline = pending.indexOf(10)) !== -1) {
      if (newline > MAX_PORTABLE_ROW_BYTES) fail("PORTABLE_ROW_INVALID");
      let parsed;
      try {
        parsed = JSON.parse(decoder.decode(pending.subarray(0, newline)));
      } catch {
        fail("PORTABLE_ROW_INVALID");
      }
      yield parsed;
      pending = pending.subarray(newline + 1);
    }
    if (pending.length > MAX_PORTABLE_ROW_BYTES) fail("PORTABLE_ROW_INVALID");
  }
  if (pending.length !== 0) fail("PORTABLE_DATABASE_TRUNCATED");
}

async function readRequired(iterator) {
  const result = await iterator.next();
  if (result.done) fail("PORTABLE_DATABASE_TRUNCATED");
  return result.value;
}

function ledgerDigest(rows) {
  if (
    rows.length < 1 ||
    rows.some(
      ([name, sum]) =>
        typeof name !== "string" ||
        !/^\d{4}_[a-z0-9_]+\.sql$/u.test(name) ||
        typeof sum !== "string" ||
        !/^[a-f0-9]{64}$/u.test(sum),
    )
  )
    fail("PORTABLE_MIGRATIONS_MISMATCH");
  return createHash("sha256")
    .update(
      [...rows]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, sum]) => `${name}\0${sum}\n`)
        .join(""),
    )
    .digest("hex");
}

// All SQL is generated from the freshly migrated target schema; foreign data
// supplies only parameter values. No external dump/DDL/function reaches psql.
export async function importPortableDatabase(
  client,
  input,
  expected,
  shadow,
  timestamp = new Date().toISOString(),
) {
  requirePortableInventory(expected.inventory);
  if (typeof shadow !== "string" || !/^laundry_restore_[a-f0-9]{32}$/u.test(shadow))
    fail("PORTABLE_SHADOW_REQUIRED");
  const { rows: identities } = await client.query(
    "SELECT current_database() AS name, pg_catalog.shobj_description(oid, 'pg_database') AS marker FROM pg_catalog.pg_database WHERE datname = current_database()",
  );
  if (identities.length !== 1 || identities[0].name !== shadow || identities[0].marker !== shadow)
    fail("PORTABLE_SHADOW_REQUIRED");
  const schema = await discoverPortableSchema(client);
  if (schemaFingerprint(schema) !== schemaFingerprint(expected.inventory.schema))
    fail("PORTABLE_SCHEMA_MISMATCH");
  const targetLedger = await client.query(
    "SELECT filename, checksum FROM public.laundry_schema_migrations",
  );
  if (ledgerDigest(targetLedger.rows.map((r) => [r.filename, r.checksum])) !== expected.migrations)
    fail("PORTABLE_MIGRATIONS_MISMATCH");
  const contentHash = createHash("sha256");
  let contentSize = 0;
  const iterator = portableLines({
    read: async (buffer, offset, length, position) => {
      const result = await input.read(buffer, offset, length, position);
      contentHash.update(buffer.subarray(offset, offset + result.bytesRead));
      contentSize += result.bytesRead;
      return result;
    },
  })[Symbol.asyncIterator]();
  const header = await readRequired(iterator);
  if (
    JSON.stringify(header) !==
    JSON.stringify({
      version: 1,
      schema_sha256: schemaFingerprint(schema),
      migrations_sha256: expected.migrations,
    })
  )
    fail("PORTABLE_SCHEMA_MISMATCH");
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL TimeZone = 'UTC'; SET LOCAL DateStyle = 'ISO, YMD'");
    for (const table of schema) {
      if (JSON.stringify(await readRequired(iterator)) !== JSON.stringify({ table: table.name }))
        fail("PORTABLE_TABLE_ORDER_INVALID");
      const temporary = identifier(`restore_${schema.indexOf(table)}`);
      const columns = table.columns.map((c) => identifier(c.name)).join(",");
      const parameters = table.columns.map((_c, index) => `$${index + 1}`).join(",");
      const imported = table.name !== PORTABLE_LEDGER_TABLE;
      if (imported)
        await client.query(
          `CREATE TEMP TABLE ${temporary} (LIKE public.${identifier(table.name)} INCLUDING DEFAULTS) ON COMMIT DROP`,
        );
      let count = 0;
      const ledger = [];
      while (true) {
        const values = await readRequired(iterator);
        if (values === null) break;
        requirePortableRow(values, table);
        if (OMIT_PORTABLE_TABLE_DATA.has(table.name)) fail("PORTABLE_CREDENTIAL_DATA_FORBIDDEN");
        count++;
        if (count > 5_000_000) fail("PORTABLE_DATABASE_TOO_LARGE");
        if (imported)
          await client.query(
            `INSERT INTO ${temporary} (${columns}) VALUES (${parameters})`,
            resetPortableAuthority(table, values, timestamp),
          );
        else ledger.push(values);
      }
      if (count !== expected.inventory.counts[table.name]) fail("PORTABLE_ROW_COUNT_MISMATCH");
      if (!imported) {
        const file = table.columns.findIndex((c) => c.name === "filename");
        const checksum = table.columns.findIndex((c) => c.name === "checksum");
        const hash = ledgerDigest(ledger.map((v) => [v[file], v[checksum]]));
        if (hash !== expected.migrations) fail("PORTABLE_MIGRATIONS_MISMATCH");
      }
    }
    if (!(await iterator.next()).done) fail("PORTABLE_DATABASE_TRAILING_DATA");
    if (
      contentSize !== expected.inventory.size ||
      contentHash.digest("hex") !== expected.inventory.sha256
    )
      fail("PORTABLE_DATABASE_HASH_MISMATCH");
    const imported = schema.filter((t) => t.name !== PORTABLE_LEDGER_TABLE);
    // Existing business FKs contain cycles. Defer their checks only inside the
    // bound shadow transaction, then validate and restore each trusted definition.
    const foreignKeys =
      await client.query(`SELECT c.relname AS table_name, k.conname AS name, k.condeferrable AS deferrable, k.condeferred AS deferred
      FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND k.contype='f' ORDER BY c.relname,k.conname`);
    for (const key of foreignKeys.rows)
      await client.query(
        `ALTER TABLE public.${identifier(key.table_name)} ALTER CONSTRAINT ${identifier(key.name)} DEFERRABLE INITIALLY DEFERRED`,
      );
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    for (const table of imported)
      await client.query(`ALTER TABLE public.${identifier(table.name)} DISABLE TRIGGER USER`);
    await client.query(
      `TRUNCATE ${imported.map((t) => `public.${identifier(t.name)}`).join(",")} RESTART IDENTITY`,
    );
    for (const table of imported) {
      const target = `public.${identifier(table.name)}`;
      const columns = table.columns.map((c) => identifier(c.name)).join(",");
      // Disable only application mutation guards in this empty, isolated shadow.
      // FK/check constraints stay active. Transaction rollback restores triggers.
      await client.query(
        `INSERT INTO ${target} (${columns}) OVERRIDING SYSTEM VALUE SELECT ${columns} FROM ${identifier(`restore_${schema.indexOf(table)}`)}`,
      );
      for (const sequence of table.sequences)
        await client.query(
          `SELECT pg_catalog.setval($1::regclass, GREATEST(COALESCE(MAX(${identifier(sequence.column)}), 1), $2::bigint), COUNT(*) > 0 OR $3::boolean) FROM ${target}`,
          [
            `public.${sequence.name}`,
            expected.inventory.sequences[sequence.name].value,
            expected.inventory.sequences[sequence.name].called,
          ],
        );
    }
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    for (const table of imported)
      await client.query(`ALTER TABLE public.${identifier(table.name)} ENABLE TRIGGER USER`);
    for (const key of foreignKeys.rows)
      await client.query(
        `ALTER TABLE public.${identifier(key.table_name)} ALTER CONSTRAINT ${identifier(key.name)} ${key.deferrable ? `DEFERRABLE INITIALLY ${key.deferred ? "DEFERRED" : "IMMEDIATE"}` : "NOT DEFERRABLE"}`,
      );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
