import type { QueryPort } from "../commands/types.js";
import { parsePrintQueue, type PrintJobView } from "../shell/print-jobs.js";
import type { OrderListRowView } from "./OrdersList.js";
import { parseOrderPage } from "./use-order-page.js";

export type CustomerHistory = Readonly<{
  orders: readonly OrderListRowView[];
  total: number;
  offset: number;
  limit: number;
  /** Null means print status was unavailable; an empty array is a valid result. */
  printJobs: readonly PrintJobView[] | null;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapResult(value: unknown): unknown {
  return isRecord(value) && "result" in value ? value.result : value;
}

/** Load the customer's bounded order and print references without exposing transport details. */
export async function loadCustomerHistory(
  queryClient: QueryPort,
  customerPhone: string,
  offset = 0,
  customerId?: string,
): Promise<CustomerHistory | null> {
  try {
    const [orderRead, printRead] = await Promise.allSettled([
      queryClient.execute<unknown>("order.list", {
        ...(customerId === undefined
          ? { customer_phone: customerPhone }
          : { customer_id: customerId }),
        offset,
        limit: 20,
      }),
      queryClient.execute<unknown>("print.jobs.list", { limit: 50 }),
    ]);
    if (orderRead.status !== "fulfilled" || !orderRead.value.ok) return null;
    const page = parseOrderPage(unwrapResult(orderRead.value.data));
    if (page === null || page.offset !== offset || page.limit !== 20) return null;
    const orders = page.orders;
    const orderIds = new Set(orders.map((order) => order.order_id));
    const printQueue =
      printRead.status === "fulfilled" && printRead.value.ok
        ? parsePrintQueue(printRead.value.data)
        : null;
    const printJobs =
      printQueue === null
        ? null
        : Object.freeze(printQueue.jobs.filter((job) => orderIds.has(job.order_id)));
    return Object.freeze({ ...page, printJobs });
  } catch {
    return null;
  }
}
