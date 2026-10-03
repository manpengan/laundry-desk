import { digest, exactKeys, fail } from "./companion-contract.mjs";

export const MAX_PORTABLE_TABLES = 256;
export const MAX_PORTABLE_ROW_BYTES = 16 * 1024 * 1024;
export const MAX_PORTABLE_DATABASE_BYTES = 512 * 1024 * 1024;
export const PORTABLE_LEDGER_TABLE = "laundry_schema_migrations";
const NAME = /^[a-z][a-z0-9_]{0,62}$/u;

export function identifier(value) {
  if (typeof value !== "string" || !NAME.test(value)) fail("PORTABLE_SCHEMA_INVALID");
  return `"${value}"`;
}

export function requirePortableSchema(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PORTABLE_TABLES)
    fail("PORTABLE_SCHEMA_INVALID");
  const names = new Set();
  for (const table of value) {
    if (
      !exactKeys(table, ["name", "columns", "parents", "sequences"]) ||
      !Array.isArray(table.columns) ||
      table.columns.length < 1 ||
      table.columns.length > 128 ||
      !Array.isArray(table.parents) ||
      !Array.isArray(table.sequences) ||
      names.has(table.name)
    )
      fail("PORTABLE_SCHEMA_INVALID");
    identifier(table.name);
    names.add(table.name);
    const columns = new Set();
    for (const column of table.columns) {
      if (
        !exactKeys(column, ["name", "type"]) ||
        typeof column.type !== "string" ||
        column.type.length < 1 ||
        column.type.length > 128 ||
        columns.has(column.name)
      )
        fail("PORTABLE_SCHEMA_INVALID");
      identifier(column.name);
      columns.add(column.name);
    }
    for (const parent of table.parents) identifier(parent);
    const sequences = new Set();
    for (const sequence of table.sequences) {
      if (
        !exactKeys(sequence, ["column", "name"]) ||
        !columns.has(sequence.column) ||
        sequences.has(sequence.name)
      )
        fail("PORTABLE_SCHEMA_INVALID");
      identifier(sequence.name);
      sequences.add(sequence.name);
    }
  }
  if (!names.has(PORTABLE_LEDGER_TABLE) || value.some((t) => t.parents.some((p) => !names.has(p))))
    fail("PORTABLE_SCHEMA_INVALID");
  return value;
}

export function requirePortableInventory(value) {
  if (
    !exactKeys(value, ["schema", "counts", "sequences", "size", "sha256"]) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    value.size > MAX_PORTABLE_DATABASE_BYTES ||
    !/^[a-f0-9]{64}$/u.test(value.sha256)
  )
    fail("PORTABLE_INVENTORY_INVALID");
  const schema = requirePortableSchema(value.schema);
  if (
    !exactKeys(
      value.counts,
      schema.map((t) => t.name),
    ) ||
    Object.values(value.counts).some((n) => !Number.isSafeInteger(n) || n < 0 || n > 5_000_000)
  )
    fail("PORTABLE_INVENTORY_INVALID");
  const names = schema.flatMap((t) => t.sequences.map((s) => s.name));
  if (!exactKeys(value.sequences, names)) fail("PORTABLE_INVENTORY_INVALID");
  for (const state of Object.values(value.sequences)) {
    if (
      !exactKeys(state, ["value", "called"]) ||
      typeof state.value !== "string" ||
      !/^[1-9][0-9]{0,18}$/u.test(state.value) ||
      BigInt(state.value) > 9223372036854775807n ||
      typeof state.called !== "boolean"
    )
      fail("PORTABLE_INVENTORY_INVALID");
  }
  return value;
}

export function schemaFingerprint(schema) {
  return digest(JSON.stringify(requirePortableSchema(schema)));
}

// Only the local, freshly migrated database may supply authority for identifiers
// and casts. The archive's inventory is compared byte-for-byte before use.
export async function discoverPortableSchema(client) {
  const { rows } = await client.query(`SELECT c.relname AS name,
    COALESCE((SELECT json_agg(json_build_object('name', a.attname, 'type', pg_catalog.format_type(a.atttypid, a.atttypmod)) ORDER BY a.attnum)
      FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''), '[]') AS columns,
    COALESCE((SELECT json_agg(p.name ORDER BY p.name) FROM (SELECT DISTINCT r.relname AS name FROM pg_catalog.pg_constraint k
      JOIN pg_catalog.pg_class r ON r.oid = k.confrelid WHERE k.conrelid = c.oid AND k.contype = 'f' AND k.confrelid <> c.oid) p), '[]') AS parents,
    COALESCE((SELECT json_agg(json_build_object('column', a.attname, 'name', s.relname) ORDER BY a.attnum)
      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class s ON s.oid = pg_catalog.pg_get_serial_sequence('public.' || quote_ident(c.relname), a.attname)::regclass
      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '[]') AS sequences
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`);
  return requirePortableSchema(rows);
}

export function portableLoadOrder(schema) {
  const remaining = new Map(requirePortableSchema(schema).map((table) => [table.name, table]));
  const ordered = [];
  while (remaining.size > 0) {
    const next = [...remaining.values()].find((table) =>
      table.parents.every((parent) => !remaining.has(parent)),
    );
    if (!next) fail("PORTABLE_SCHEMA_DEPENDENCY_CYCLE");
    ordered.push(next);
    remaining.delete(next.name);
  }
  return ordered;
}

export function requirePortableRow(values, table) {
  if (
    !Array.isArray(values) ||
    values.length !== table.columns.length ||
    values.some((value) => value !== null && (typeof value !== "string" || value.includes("\0")))
  )
    fail("PORTABLE_ROW_INVALID");
  if (Buffer.byteLength(JSON.stringify(values)) > MAX_PORTABLE_ROW_BYTES)
    fail("PORTABLE_ROW_INVALID");
  return values;
}
