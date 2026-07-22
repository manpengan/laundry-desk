import assert from "node:assert/strict";
import test from "node:test";

import { createMockQueryClient } from "../commands/query-client.js";
import type { QueryPort } from "../commands/types.js";
import {
  loadPrintJobs,
  loadPrintJobSummary,
  parsePrintJobsList,
  printJobStatusLabel,
  summarizePrintJobs,
  type PrintJobView,
} from "./print-jobs.js";

const SAMPLE_JOBS: readonly PrintJobView[] = Object.freeze([
  Object.freeze({
    job_id: "11111111-1111-4111-8111-111111111111",
    kind: "xp58",
    status: "queued" as const,
    order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ticket_no: "T-QUEUED",
    created_at: 100,
    updated_at: 100,
  }),
  Object.freeze({
    job_id: "22222222-2222-4222-8222-222222222222",
    kind: "xp58",
    status: "printing" as const,
    order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ticket_no: "T-PRINT",
    created_at: 200,
    updated_at: 210,
  }),
  Object.freeze({
    job_id: "33333333-3333-4333-8333-333333333333",
    kind: "dl206",
    status: "failed" as const,
    order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ticket_no: "T-FAIL",
    created_at: 300,
    updated_at: 320,
    error: "纸尽",
  }),
  Object.freeze({
    job_id: "44444444-4444-4444-8444-444444444444",
    kind: "xp58",
    status: "done" as const,
    order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ticket_no: "T-DONE",
    created_at: 400,
    updated_at: 450,
  }),
]);

test("summarizePrintJobs counts queued+printing and failed; ignores done", () => {
  const summary = summarizePrintJobs(SAMPLE_JOBS);
  assert.equal(summary.queued, 2);
  assert.equal(summary.failed, 1);
});

test("summarizePrintJobs empty is idle", () => {
  assert.deepEqual(summarizePrintJobs([]), { queued: 0, failed: 0 });
});

test("printJobStatusLabel uses Chinese-friendly labels", () => {
  assert.equal(printJobStatusLabel("queued"), "排队中");
  assert.equal(printJobStatusLabel("printing"), "打印中");
  assert.equal(printJobStatusLabel("done"), "已完成");
  assert.equal(printJobStatusLabel("failed"), "失败");
  assert.equal(printJobStatusLabel("unknown"), "unknown");
});

test("parsePrintJobsList accepts bus envelope and drops bad rows", () => {
  const parsed = parsePrintJobsList({
    execution: "executed",
    result: {
      jobs: [SAMPLE_JOBS[0], { job_id: "x", status: "nope" }, SAMPLE_JOBS[2]],
    },
  });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.ticket_no, "T-QUEUED");
  assert.equal(parsed[1]?.error, "纸尽");
});

test("default mock query client returns empty print.jobs.list", async () => {
  const client = createMockQueryClient();
  const jobs = await loadPrintJobs(client, 20);
  assert.ok(jobs !== null);
  assert.equal(jobs.length, 0);
  const summary = await loadPrintJobSummary(client);
  assert.deepEqual(summary, { queued: 0, failed: 0 });
});

test("loadPrintJobSummary from mock with sample jobs drives indicator counts", async () => {
  const client: QueryPort = createMockQueryClient(async <T = unknown>(name: string) => {
    assert.equal(name, "print.jobs.list");
    return Object.freeze({
      ok: true as const,
      data: Object.freeze({
        execution: "executed",
        result: Object.freeze({ jobs: SAMPLE_JOBS }),
      }) as T,
    });
  });
  const summary = await loadPrintJobSummary(client);
  assert.deepEqual(summary, { queued: 2, failed: 1 });
});

test("loadPrintJobs returns null on failure (keep last summary)", async () => {
  const client: QueryPort = createMockQueryClient(
    async <T = unknown>() =>
      Object.freeze({
        ok: false as const,
        error: Object.freeze({ code: "NETWORK", message: "down" }),
      }) as import("../commands/types.js").CommandResult<T>,
  );
  assert.equal(await loadPrintJobs(client), null);
  assert.equal(await loadPrintJobSummary(client), null);
});
