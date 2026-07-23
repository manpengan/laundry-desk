import type {
  ReconciliationReport,
  ReconciliationTotals,
  V1Snapshot,
  V2MigrationPlan,
} from "./types.js";

function checkedTotal(left: number, right: number, name: string): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new RangeError(`${name} exceeds a safe integer`);
  return total;
}

function sourceTotals(snapshot: V1Snapshot): ReconciliationTotals {
  let garments = 0;
  for (const item of snapshot.orderItems)
    garments = checkedTotal(garments, item.quantity, "source garments");
  let receivableCents = 0;
  let paidCents = 0;
  let debtCents = 0;
  for (const order of snapshot.orders) {
    receivableCents = checkedTotal(receivableCents, order.totalCents, "source receivable");
    paidCents = checkedTotal(paidCents, order.paidCents, "source paid");
    debtCents = checkedTotal(debtCents, order.totalCents - order.paidCents, "source debt");
  }
  return Object.freeze({
    orders: snapshot.orders.length,
    garments,
    customers: snapshot.customers.length,
    receivableCents,
    paidCents,
    debtCents,
    photos: snapshot.orderPhotos.length,
  });
}

function targetTotals(plan: V2MigrationPlan): ReconciliationTotals {
  let garments = 0;
  let receivableCents = 0;
  let paidCents = 0;
  let debtCents = 0;
  for (const order of plan.orders) {
    garments = checkedTotal(garments, order.garments.length, "target garments");
    receivableCents = checkedTotal(receivableCents, order.payableCents, "target receivable");
    paidCents = checkedTotal(paidCents, order.paidCents, "target paid");
    debtCents = checkedTotal(debtCents, order.balanceCents, "target debt");
  }
  return Object.freeze({
    orders: plan.orders.length,
    garments,
    customers: plan.customers.length,
    receivableCents,
    paidCents,
    debtCents,
    photos: plan.photos.length,
  });
}

function differences(
  source: ReconciliationTotals,
  target: ReconciliationTotals,
): ReconciliationTotals {
  return Object.freeze({
    orders: target.orders - source.orders,
    garments: target.garments - source.garments,
    customers: target.customers - source.customers,
    receivableCents: target.receivableCents - source.receivableCents,
    paidCents: target.paidCents - source.paidCents,
    debtCents: target.debtCents - source.debtCents,
    photos: target.photos - source.photos,
  });
}

export function reconcileMigration(
  snapshot: V1Snapshot,
  plan: V2MigrationPlan,
): ReconciliationReport {
  const source = sourceTotals(snapshot);
  const target = targetTotals(plan);
  const difference = differences(source, target);
  const isZeroDifference = Object.values(difference).every((value) => value === 0);
  return Object.freeze({
    sourceBackupSha256: snapshot.sourceBackupSha256,
    source,
    target,
    differences: difference,
    isZeroDifference,
  });
}
