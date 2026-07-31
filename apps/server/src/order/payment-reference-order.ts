import type { LedgerPaymentRow } from "./types.js";

const INVALID_REFERENCE_GRAPH = "Payment ledger reference graph is invalid";

function sameScope(left: LedgerPaymentRow, right: LedgerPaymentRow): boolean {
  return (
    left.org_id === right.org_id &&
    left.store_id === right.store_id &&
    left.order_id === right.order_id
  );
}

function invalidReferenceGraph(): Error {
  return new Error(INVALID_REFERENCE_GRAPH);
}

/**
 * Stable dependency-first ordering for rows whose database timestamps can tie.
 * The first-seen order is retained except where a reference must precede its child.
 */
export function orderPaymentsByReference(
  rows: readonly LedgerPaymentRow[],
): readonly LedgerPaymentRow[] {
  const byId = new Map<string, LedgerPaymentRow>();
  for (const row of rows) {
    if (byId.has(row.payment_id)) throw invalidReferenceGraph();
    byId.set(row.payment_id, row);
  }

  const visiting = new Set<string>();
  const emitted = new Set<string>();
  const ordered: LedgerPaymentRow[] = [];
  const visit = (row: LedgerPaymentRow): void => {
    if (emitted.has(row.payment_id)) return;
    if (visiting.has(row.payment_id)) throw invalidReferenceGraph();
    visiting.add(row.payment_id);
    if (row.ref_payment_id !== null) {
      const parent = byId.get(row.ref_payment_id);
      if (parent === undefined || !sameScope(parent, row)) throw invalidReferenceGraph();
      visit(parent);
    }
    visiting.delete(row.payment_id);
    emitted.add(row.payment_id);
    ordered.push(row);
  };

  for (const row of rows) visit(row);
  return Object.freeze([...ordered]);
}
