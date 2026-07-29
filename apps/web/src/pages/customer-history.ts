import type { QueryPort } from "../commands/types.js";
import { parsePrintQueue, type PrintJobView } from "../shell/print-jobs.js";
import { parseOrderListRows, type OrderListRowView } from "./OrdersList.js";

export type CustomerHistory = Readonly<{
  orders: readonly OrderListRowView[];
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
): Promise<CustomerHistory | null> {
  try {
    const [ordersResponse, printResponse] = await Promise.all([
      queryClient.execute<unknown>("order.list", {
        customer_phone: customerPhone,
        limit: 20,
      }),
      queryClient.execute<unknown>("print.jobs.list", { limit: 50 }),
    ]);
    if (!ordersResponse.ok) return null;
    const orders = parseOrderListRows(unwrapResult(ordersResponse.data));
    if (orders === null) return null;
    const orderIds = new Set(orders.map((order) => order.order_id));
    const printQueue = printResponse.ok ? parsePrintQueue(printResponse.data) : null;
    const printJobs =
      printQueue === null
        ? null
        : Object.freeze(printQueue.jobs.filter((job) => orderIds.has(job.order_id)));
    return Object.freeze({ orders, printJobs });
  } catch {
    return null;
  }
}
