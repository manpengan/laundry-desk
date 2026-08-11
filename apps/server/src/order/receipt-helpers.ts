import type { CustomerStore } from "../customer/types.js";

/** Customer archival is transaction-bound to receipt creation. */
export async function upsertCustomerForReceipt(
  customer: CustomerStore,
  phone: string,
  name: string | undefined,
  now: number,
): ReturnType<CustomerStore["upsert"]> {
  return customer.upsert({
    phone,
    ...(name === undefined ? {} : { name }),
    now,
  });
}

export function formatTicket(dayKey: string, seq: number): string {
  return `${dayKey}-${String(seq).padStart(4, "0")}`;
}

/** Ticket numbers are store-unique, so no second counter is needed. */
export function formatPickupCode(ticketNo: string): string {
  return `P${ticketNo.replace("-", "")}`;
}
