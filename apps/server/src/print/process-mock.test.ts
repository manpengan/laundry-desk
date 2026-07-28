/**
 * print.ticket.process routed through the mock spool.
 *
 * ADR-14 defers real hardware, so when a spool is configured this command must
 * produce a file artifact instead of ESC/POS bytes — and must keep the ESC/POS
 * path untouched when no spool is configured.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { createFileSpool, type FileSpool } from "./file-spool.js";
import { createPrintCommandHandlers, type PrintHandlerDeps } from "./handlers.js";
import { MemoryPrintJobStore } from "./memory-store.js";
import type { PrintJobClaim, PrintJobStore, TransitionPrintJobOptions } from "./types.js";

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempSpool(): Promise<FileSpool> {
  const dir = await mkdtemp(join(tmpdir(), "laundry-process-"));
  dirs.push(dir);
  return createFileSpool({ rootPath: join(dir, "spool") });
}

const ORDER = "11111111-1111-4111-8111-111111111111";

/**
 * MemoryPrintJobStore has no lease support, so wrap it with the claim-by-id the
 * mock path needs. Claiming here just mirrors the PG semantics: queued becomes
 * printing and the attempt is counted.
 */
function claimableStore(base: PrintJobStore): PrintJobStore {
  const attempts = new Map<string, number>();
  // Delegate explicitly: MemoryPrintJobStore is a class, so spreading it would
  // drop every prototype method.
  return Object.freeze({
    enqueue: (input) => base.enqueue(input),
    list: (limit) => base.list(limit),
    get: (jobId) => base.get(jobId),
    claimJob: async (jobId: string): Promise<PrintJobClaim | null> => {
      const job = await base.get(jobId);
      if (job === null || job.status !== "queued") return null;
      const attempt = (attempts.get(jobId) ?? 0) + 1;
      attempts.set(jobId, attempt);
      await base.transition(jobId, "printing", {});
      return Object.freeze({
        job_id: job.job_id,
        kind: job.kind,
        order_id: job.order_id,
        ticket_no: job.ticket_no,
        attempt_count: attempt,
        lease_until: 1_800_000_030,
        worker_id: "test-worker",
      });
    },
    transition: async (jobId: string, status: string, options?: TransitionPrintJobOptions) =>
      base.transition(jobId, status as never, options),
  }) as PrintJobStore;
}

async function enqueueJob(deps: PrintHandlerDeps): Promise<string> {
  const handlers = createPrintCommandHandlers(deps);
  const outcome = await handlers["print.ticket.enqueue"]!({
    parsed: { order_id: ORDER, ticket_no: "T-77", kind: "xp58" },
  } as never);
  return (outcome.result as { job_id: string }).job_id;
}

test("process writes a spool artifact and completes the job", async () => {
  const spool = await tempSpool();
  const deps: PrintHandlerDeps = Object.freeze({
    store: claimableStore(new MemoryPrintJobStore()),
    spool,
    workerId: "test-worker",
    now: () => 1_800_000_000,
  });
  const jobId = await enqueueJob(deps);

  const handlers = createPrintCommandHandlers(deps);
  const outcome = await handlers["print.ticket.process"]!({ parsed: { job_id: jobId } } as never);

  const result = outcome.result as { status: string; job_id: string };
  assert.equal(result.status, "done");
  assert.equal(result.job_id, jobId);

  const written = await readFile(join(spool.rootPath, `${jobId}-xp58-0001.txt`), "utf8");
  assert.match(written, /LAUNDRY DESK MOCK PRINT/u);
  assert.match(written, /ticket {4}: T-77/u, "the artifact carries the real ticket number");
});

test("processing a job twice is rejected rather than printing again", async () => {
  const spool = await tempSpool();
  const deps: PrintHandlerDeps = Object.freeze({
    store: claimableStore(new MemoryPrintJobStore()),
    spool,
    workerId: "test-worker",
    now: () => 1_800_000_000,
  });
  const jobId = await enqueueJob(deps);
  const handlers = createPrintCommandHandlers(deps);
  await handlers["print.ticket.process"]!({ parsed: { job_id: jobId } } as never);

  await assert.rejects(
    () => handlers["print.ticket.process"]!({ parsed: { job_id: jobId } } as never),
    "a completed job must not be claimable again",
  );
});

test("without a spool the ESC/POS path is unchanged", async () => {
  const deps: PrintHandlerDeps = Object.freeze({
    store: new MemoryPrintJobStore(),
    now: () => 1_800_000_000,
  });
  const jobId = await enqueueJob(deps);

  const handlers = createPrintCommandHandlers(deps);
  const outcome = await handlers["print.ticket.process"]!({ parsed: { job_id: jobId } } as never);

  const result = outcome.result as { status: string; payload_bytes?: number };
  assert.equal(result.status, "done");
  // ESC/POS reports the byte length it built; the mock path has no such number.
  assert.equal(typeof result.payload_bytes, "number");
  assert.ok((result.payload_bytes ?? 0) > 0);
});
