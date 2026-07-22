import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import { createMockAuthClient } from "../auth/AuthClient.js";
import { FULL_STORE_FEATURES } from "../auth/permissions.js";
import type { AccessSession } from "../auth/types.js";
import { createMockQueryClient } from "../commands/query-client.js";
import type { QueryPort } from "../commands/types.js";
import { createMockConnection } from "../connection.js";
import { CounterShell } from "./CounterShell.js";
import { PrintQueuePanel } from "./PrintQueuePanel.js";
import type { PrintJobView } from "./print-jobs.js";

const sampleSession: AccessSession = Object.freeze({
  access_token: "eyJhbGciOiJub25lIn0.e30.mocksig",
  token_type: "Bearer" as const,
  expires_in: 900,
  storage: "memory_only" as const,
  session: Object.freeze({
    session_id: "aaaaaaaa-bbbb-4ccc-8ddd-111111111111",
    session_version: 1,
    org_id: "aaaaaaaa-bbbb-4ccc-8ddd-222222222222",
    store_id: "aaaaaaaa-bbbb-4ccc-8ddd-333333333333",
    staff_id: "11111111-1111-4111-8111-111111111101",
    device_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    permission_version: 1,
  }),
  role: "admin" as const,
  features: FULL_STORE_FEATURES,
  display: Object.freeze({
    store_name: "宏发演示店",
    staff_name: "店员",
    org_code: "ORG",
    store_code: "S1",
  }),
});

const SAMPLE_JOBS: readonly PrintJobView[] = Object.freeze([
  Object.freeze({
    job_id: "11111111-1111-4111-8111-111111111111",
    kind: "xp58",
    status: "queued" as const,
    order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ticket_no: "20260722-0001",
    created_at: 100,
    updated_at: 100,
  }),
  Object.freeze({
    job_id: "22222222-2222-4222-8222-222222222222",
    kind: "xp58",
    status: "failed" as const,
    order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ticket_no: "20260722-0002",
    created_at: 200,
    updated_at: 220,
    error: "打印机离线",
  }),
]);

test("PrintQueuePanel lists ticket_no, Chinese status, and error", () => {
  const html = renderToStaticMarkup(
    createElement(PrintQueuePanel, {
      open: true,
      onClose: () => undefined,
      queryClient: createMockQueryClient(),
      initialJobs: SAMPLE_JOBS,
    }),
  );
  assert.match(html, /data-testid="print-queue-panel"/);
  assert.match(html, /20260722-0001/);
  assert.match(html, /20260722-0002/);
  assert.match(html, /排队中/);
  assert.match(html, /失败/);
  assert.match(html, /打印机离线/);
  assert.match(html, /刷新/);
});

test("PrintQueuePanel closed renders nothing", () => {
  const html = renderToStaticMarkup(
    createElement(PrintQueuePanel, {
      open: false,
      onClose: () => undefined,
      queryClient: createMockQueryClient(),
      initialJobs: SAMPLE_JOBS,
    }),
  );
  assert.equal(html, "");
});

test("CounterShell with injected printSummary shows failed/queued counts on indicator", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(CounterShell, {
        session: sampleSession,
        authClient: createMockAuthClient(),
        onSessionChange: () => undefined,
        initialConnection: createMockConnection({ storeName: "宏发演示店" }),
        printSummary: { queued: 3, failed: 2 },
      }),
    ),
  );
  assert.match(html, /打印失败 2/);
  assert.match(html, /data-failed="2"/);
  assert.match(html, /data-queued="3"/);
});

test("CounterShell wires print indicator open handler with mock query jobs", () => {
  const queryClient: QueryPort = createMockQueryClient(async <T = unknown>(name: string) => {
    if (name === "print.jobs.list") {
      return Object.freeze({
        ok: true as const,
        data: Object.freeze({
          execution: "executed",
          result: Object.freeze({ jobs: SAMPLE_JOBS }),
        }) as T,
      });
    }
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({ code: "RESOURCE_UNAVAILABLE", message: "n/a" }),
    });
  });
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(CounterShell, {
        session: sampleSession,
        authClient: createMockAuthClient(),
        onSessionChange: () => undefined,
        initialConnection: createMockConnection({ storeName: "宏发演示店" }),
        queryClient,
        printSummary: { queued: 1, failed: 1 },
      }),
    ),
  );
  assert.match(html, /打印失败 1/);
  assert.match(html, /data-queued="1"/);
  assert.match(html, /data-failed="1"/);
  assert.match(html, /aria-label="打印失败 1"/);
});
