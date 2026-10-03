import type Database from "better-sqlite3";
import { v1HistorySchema, type V1History } from "./history.js";

/** Deliberately never SELECT password_hash. Old passwords neither become V2
 * credentials nor enter historical exports. The explicit count is reviewed. */
const TABLES = Object.freeze({
  staffs: "id username password_hash display_name role is_active created_at last_login_at",
  sms_log: "id order_id phone content status provider_response sent_at",
  audit_log: "id staff_id action entity entity_id diff created_at",
});
export function extractHistory(database: Database.Database): V1History {
  const names = (
    database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
  const known = new Set([
    "customers",
    "orders",
    "order_items",
    "order_photos",
    "settings",
    ...Object.keys(TABLES),
  ]);
  if (names.some((name) => !known.has(name) && !name.startsWith("sqlite_")))
    throw new Error("V1_MIGRATION_UNKNOWN_SOURCE_TABLE");
  const read = (table: keyof typeof TABLES): readonly unknown[] => {
    if (!names.includes(table)) return [];
    const columns = TABLES[table].split(" ");
    const actual = database
      .prepare("SELECT name,hidden FROM pragma_table_xinfo(?) ORDER BY cid")
      .all(table) as Array<{ name: string; hidden: number }>;
    if (
      actual.length !== columns.length ||
      actual.some((row, index) => row.name !== columns[index] || row.hidden !== 0)
    )
      throw new Error("V1_MIGRATION_SOURCE_COLUMNS_REQUIRE_MAPPING");
    const selected = columns.filter((column) => column !== "password_hash").join(",");
    const rows: unknown[] = [];
    for (const row of database.prepare(`SELECT ${selected} FROM ${table} ORDER BY id`).iterate()) {
      if (rows.length >= 100_000) throw new Error("V1_MIGRATION_HISTORY_LIMIT");
      rows.push(row);
    }
    return rows;
  };
  const staffs = read("staffs");
  return v1HistorySchema.parse({
    staffs,
    sms: read("sms_log"),
    audit: read("audit_log"),
    excluded_credential_count: staffs.length,
  });
}
