import type { CustomerStore } from "../customer/types.js";
import { CustomerErasedError } from "../customer/types.js";
import { createCommandError } from "@laundry/contracts";
import { HandlerCommandError } from "../bus/types.js";

/** Customer archival is transaction-bound to receipt creation. */
export async function upsertCustomerForReceipt(
  customer: CustomerStore,
  phone: string,
  name: string | undefined,
  now: number,
): ReturnType<CustomerStore["upsert"]> {
  return customer
    .upsert({
      phone,
      ...(name === undefined ? {} : { name }),
      now,
    })
    .catch((error: unknown) => {
      if (error instanceof CustomerErasedError) {
        throw new HandlerCommandError(createCommandError("CUSTOMER_ERASED"));
      }
      throw error;
    });
}

export function formatTicket(dayKey: string, seq: number): string {
  return `${dayKey}-${String(seq).padStart(4, "0")}`;
}

/** Ticket numbers are store-unique, so no second counter is needed. */
export function formatPickupCode(ticketNo: string): string {
  return `P${ticketNo.replace("-", "")}`;
}
