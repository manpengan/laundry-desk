import type { V2MigrationPlan } from "@laundry/migrate-v1/plan";

/** v1 pickup codes are non-unique; v2 enforces uniqueness within a store.
 * Keep unique legacy codes. Give every colliding order a deterministic new code,
 * retaining the original separately in its erasable historical metadata. */
export function migrationPickupCodes(plan: V2MigrationPlan): ReadonlyMap<string, string> {
  const counts = new Map<string, number>();
  for (const order of plan.orders)
    counts.set(order.legacyPickupCode, (counts.get(order.legacyPickupCode) ?? 0) + 1);
  const used = new Set(plan.orders.map((order) => order.legacyPickupCode));
  const result = new Map<string, string>();
  for (const order of plan.orders) {
    if (counts.get(order.legacyPickupCode) === 1) {
      result.set(order.id, order.legacyPickupCode);
      continue;
    }
    const prefix = `V1-${order.id}`;
    let candidate = prefix;
    let suffix = 0;
    while (used.has(candidate)) candidate = `${prefix}-${++suffix}`;
    used.add(candidate);
    result.set(order.id, candidate);
  }
  return result;
}
export function reassignedPickupCount(plan: V2MigrationPlan): number {
  const codes = migrationPickupCodes(plan);
  return plan.orders.filter((order) => order.legacyPickupCode !== codes.get(order.id)).length;
}
