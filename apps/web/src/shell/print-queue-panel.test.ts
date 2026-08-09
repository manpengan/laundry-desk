import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ToastProvider } from "@laundry/ui";
import { createMockAuthClient } from "../auth/AuthClient.js";
import { FULL_STORE_FEATURES } from "../auth/permissions.js";
import type { SessionView } from "../auth/types.js";
import { createMockCommandClient } from "../commands/command-client.js";
import { createMockQueryClient } from "../commands/query-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { createMockConnection } from "../connection.js";
import { CounterShell } from "./CounterShell.js";
import { PrintQueuePanel } from "./PrintQueuePanel.js";
import type { PrintJobView, PrintWorkerView } from "./print-jobs.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const sampleSession: SessionView = Object.freeze({
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
  Object.freeze({
    job_id: "33333333-3333-4333-8333-333333333333",
    kind: "xp58",
    status: "done" as const,
    order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ticket_no: "20260722-0003",
    created_at: 300,
    updated_at: 310,
    payload_bytes: 128,
  }),
  Object.freeze({
    job_id: "44444444-4444-4444-8444-444444444444",
    kind: "xp58",
    status: "uncertain" as const,
    order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ticket_no: "20260722-0004",
    created_at: 400,
    updated_at: 410,
    error: "CUPS 提交结果不确定",
  }),
]);
const WORKER: PrintWorkerView = Object.freeze({
  state: "running",
  worker_id: "local-server",
  processed_jobs: 8,
  failed_jobs: 1,
  last_cycle_at: 1_721_606_400,
  last_error_code: null,
  spool_artifacts: 7,
  spool_bytes: 2_048,
});

function renderPanel(
  props: Partial<{
    open: boolean;
    initialJobs: readonly PrintJobView[];
    initialWorker: PrintWorkerView;
    commandClient: CommandPort;
    queryClient: QueryPort;
  }> = {},
): string {
  return renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(PrintQueuePanel, {
        open: props.open ?? true,
        onClose: () => undefined,
        queryClient: props.queryClient ?? createMockQueryClient(),
        commandClient: props.commandClient ?? createMockCommandClient(),
        initialJobs: props.initialJobs ?? SAMPLE_JOBS,
        initialWorker: props.initialWorker ?? WORKER,
      }),
    ),
  );
}

test("PrintQueuePanel lists ticket_no, Chinese status, and error", () => {
  const html = renderPanel();
  assert.match(html, /data-testid="print-queue-panel"/);
  assert.match(html, /20260722-0001/);
  assert.match(html, /20260722-0002/);
  assert.match(html, /排队中/);
  assert.match(html, /失败/);
  assert.match(html, /打印机离线/);
  assert.match(html, /刷新/);
  assert.match(html, /data-testid="print-worker-status"/);
  assert.match(html, /打印工作器运行中/);
  assert.match(html, /已完成 8/);
  assert.match(html, /留存 7 个文件/);
});

test("PrintQueuePanel shows 重试 for failed and 补打 for done (not for queued)", () => {
  const html = renderPanel();
  assert.match(html, /data-action="retry"/);
  assert.match(html, /重试/);
  assert.match(html, /data-action="reprint"/);
  assert.match(html, /补打/);
  // queued row has no action buttons
  assert.match(html, /data-job-id="11111111-1111-4111-8111-111111111111"/);
  const queuedSlice = html.slice(
    html.indexOf('data-job-id="11111111-1111-4111-8111-111111111111"'),
    html.indexOf('data-job-id="22222222-2222-4222-8222-222222222222"'),
  );
  assert.doesNotMatch(queuedSlice, /data-action=/);
});

test("PrintQueuePanel makes uncertain receipt explicit and never offers automatic reprint", () => {
  const html = renderPanel();
  const uncertain = html.slice(html.indexOf('data-status="uncertain"'));
  assert.match(uncertain, /结果不确定/u);
  assert.match(uncertain, /可能已经出纸/u);
  assert.match(uncertain, /系统不会自动重复打印/u);
  assert.match(uncertain, /检查纸张后重试/u);
  assert.match(uncertain, /data-action="retry"/u);
  assert.doesNotMatch(uncertain, /data-action="reprint"/u);
});

test("PrintQueuePanel keeps a requeue action locked until its refresh settles", () => {
  const source = readFileSync(join(packageRoot, "src/shell/PrintQueuePanel.tsx"), "utf8");
  const refresh = source.indexOf("await refresh();", source.indexOf("const onRequeue"));
  const release = source.indexOf("setBusyJobId(null);", refresh);

  assert.ok(refresh >= 0);
  assert.ok(release > refresh);
  assert.match(source.slice(refresh, release), /finally/u);
  assert.equal(source.match(/disabled=\{loading \|\| busyJobId !== null\}/gu)?.length, 3);
});

test("PrintQueuePanel closed renders no queue panel (toast host may remain)", () => {
  const html = renderPanel({ open: false });
  assert.doesNotMatch(html, /data-testid="print-queue-panel"/);
  assert.doesNotMatch(html, /打印队列/);
});

test("CounterShell with injected printSummary shows failed/queued counts on indicator", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(CounterShell, {
        session: sampleSession,
        authClient: createMockAuthClient(),
        commandClient: createMockCommandClient(),
        queryClient: createMockQueryClient(),
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
        commandClient: createMockCommandClient(),
        printSummary: { queued: 1, failed: 1 },
      }),
    ),
  );
  assert.match(html, /打印失败 1/);
  assert.match(html, /data-queued="1"/);
  assert.match(html, /data-failed="1"/);
  assert.match(html, /aria-label="打印失败 1"/);
});
