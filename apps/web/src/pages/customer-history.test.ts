import assert from "node:assert/strict";
import test from "node:test";

import { createMockQueryClient } from "../commands/query-client.js";
import { loadCustomerHistory } from "./customer-history.js";

const ORDER = Object.freeze({
  order_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ticket_no: "T-100",
  status: "open",
  customer_phone: "13800000111",
  customer_name: "张三",
  payable_cents: 2_000,
  paid_cents: 500,
  balance_cents: 1_500,
  created_at: 1_721_606_400,
});
const PRINT_JOB = Object.freeze({
  job_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  kind: "xp58",
  status: "done",
  order_id: ORDER.order_id,
  ticket_no: ORDER.ticket_no,
  created_at: 1_721_606_400,
  updated_at: 1_721_606_410,
});

test("loads customer orders and keeps only their print references", async () => {
  const client = createMockQueryClient(async <T = unknown>(name: string) => {
    const result =
      name === "order.list"
        ? { orders: [ORDER] }
        : {
            jobs: [
              PRINT_JOB,
              { ...PRINT_JOB, job_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", order_id: "other" },
            ],
          };
    return Object.freeze({
      ok: true as const,
      data: Object.freeze({ execution: "executed", result }) as T,
    });
  });

  const history = await loadCustomerHistory(client, "13800000111");

  assert.deepEqual(history, { orders: [ORDER], printJobs: [PRINT_JOB] });
});

test("preserves order history when print status is unavailable", async () => {
  const client = createMockQueryClient(async <T = unknown>(name: string) =>
    name === "order.list"
      ? Object.freeze({
          ok: true as const,
          data: Object.freeze({
            execution: "executed",
            result: Object.freeze({ orders: [ORDER] }),
          }) as T,
        })
      : Object.freeze({
          ok: false as const,
          error: Object.freeze({ code: "RESOURCE_UNAVAILABLE" }),
        }),
  );

  assert.deepEqual(await loadCustomerHistory(client, "13800000111"), {
    orders: [ORDER],
    printJobs: null,
  });
});
