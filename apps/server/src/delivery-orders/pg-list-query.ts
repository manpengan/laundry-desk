import { DELIVERY_ORDER_COLUMNS } from "./pg-support.js";
import type { DeliveryOrderListFilter } from "./types.js";

export function deliveryOrderListQuery(
  filter: DeliveryOrderListFilter,
): Readonly<{ sql: string; values: unknown[] }> {
  const conditions = ["org_id = $1::uuid", "store_id = $2::uuid"];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    values.push(value);
    conditions.push(sql.replace("?", `$${values.length + 2}`));
  };
  if (filter.customer_id !== undefined) {
    add(
      "customer_canonical_root(customer_id) = customer_canonical_root(?::uuid)",
      filter.customer_id,
    );
  }
  if (filter.laundry_order_id !== undefined) {
    add("laundry_order_id = ?::uuid", filter.laundry_order_id);
  }
  if (filter.status !== undefined) add("status = ?", filter.status);
  values.push(filter.limit);
  return Object.freeze({
    sql: `SELECT ${DELIVERY_ORDER_COLUMNS} FROM delivery_orders
           WHERE ${conditions.join(" AND ")}
           ORDER BY updated_at DESC, id
           LIMIT $${values.length + 2}`,
    values,
  });
}
