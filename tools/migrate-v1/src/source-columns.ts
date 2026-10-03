import type Database from "better-sqlite3";

/** Frozen business columns must be accounted for individually. Extra columns
 * cannot silently disappear through the extractor's explicit SELECT lists. */
const COLUMNS = Object.freeze({
  customers: "id name phone vip_level total_orders total_spent created_at updated_at",
  orders:
    "id order_no pickup_code customer_id status total_amount paid_amount payment_method receive_date expected_pickup_date actual_pickup_at staff_id picked_up_by notes created_at updated_at",
  order_items: "id order_id item_type service_type quantity unit_price subtotal item_notes",
  order_photos: "id order_id file_path taken_at",
  settings: "key value updated_at",
});

export function assertSourceColumns(database: Database.Database): void {
  for (const [table, columns] of Object.entries(COLUMNS)) {
    const rows = database
      .prepare("SELECT name,hidden FROM pragma_table_xinfo(?) ORDER BY cid")
      .all(table) as Array<{ name: string; hidden: number }>;
    const expected = columns.split(" ");
    if (
      rows.length !== expected.length ||
      rows.some((row, index) => row.name !== expected[index] || row.hidden !== 0)
    ) {
      throw new Error("V1_MIGRATION_SOURCE_COLUMNS_REQUIRE_MAPPING");
    }
  }
}
