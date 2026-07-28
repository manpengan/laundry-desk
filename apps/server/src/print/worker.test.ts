/**
 * Print worker step tests. The spool is real (its guarantees are filesystem
 * behaviour); the store is a small fake so claim outcomes can be scripted.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { createFileSpool, type FileSpool } from "./file-spool.js";
import type { PrintJobClaim, PrintJobStore, TransitionPrintJobOptions } from "./types.js";
import { drainPrintQueue, renderArtifact, runPrintWorkerOnce } from "./worker.js";

const created: string[] = [];
after(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempSpool(): Promise<FileSpool> {
  const dir = await mkdtemp(join(tmpdir(), "laundry-worker-"));
  created.push(dir);
  return createFileSpool({ rootPath: join(dir, "spool") });
}

const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Recorded = Readonly<{ jobId: string; status: string; options?: TransitionPrintJobOptions }>;

function fakeStore(claims: (PrintJobClaim | null)[]): {
  store: PrintJobStore;
  transitions: Recorded[];
} {
  const transitions: Recorded[] = [];
  const store = {
    enqueue: async () => {
      throw new Error("unused");
    },
    list: async () => [],
    get: async () => null,
    claimNext: async () => claims.shift() ?? null,
    transition: async (jobId: string, status: string, options?: TransitionPrintJobOptions) => {
      transitions.push({ jobId, status, ...(options === undefined ? {} : { options }) });
      return { job_id: jobId } as never;
    },
  } as unknown as PrintJobStore;
  return { store, transitions };
}

const claim = (overrides: Partial<PrintJobClaim> = {}): PrintJobClaim =>
  Object.freeze({
    job_id: JOB,
    kind: "xp58",
    order_id: "11111111-1111-4111-8111-111111111111",
    ticket_no: "T-1",
    attempt_count: 1,
    lease_until: 1_800_000_030,
    worker_id: "w1",
    ...overrides,
  });

test("prints a claimed job, spools the artifact and records it on the job", async () => {
  const spool = await tempSpool();
  const { store, transitions } = fakeStore([claim()]);

  const outcome = await runPrintWorkerOnce({
    store,
    spool,
    workerId: "w1",
    now: () => 1_800_000_000,
  });

  assert.equal(outcome.kind, "printed");
  if (outcome.kind !== "printed") return;
  assert.equal(outcome.artifact_path, `${JOB}-xp58-0001.txt`);

  const written = await readFile(join(spool.rootPath, outcome.artifact_path), "utf8");
  assert.match(written, /LAUNDRY DESK MOCK PRINT/u);
  assert.match(written, /ticket {4}: T-1/u);

  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]?.status, "done");
  assert.equal(transitions[0]?.options?.artifact?.path, outcome.artifact_path);
  assert.match(transitions[0]?.options?.artifact?.sha256 ?? "", /^[0-9a-f]{64}$/u);
  assert.equal(transitions[0]?.options?.artifact?.bytes, Buffer.byteLength(written, "utf8"));
});

test("reports idle without transitioning when nothing is claimable", async () => {
  const spool = await tempSpool();
  const { store, transitions } = fakeStore([null]);

  const outcome = await runPrintWorkerOnce({ store, spool, workerId: "w1" });

  assert.deepEqual(outcome, { kind: "idle" });
  assert.equal(transitions.length, 0);
});

test("fails the job with a safe code rather than leaking the cause", async () => {
  const spool = await tempSpool();
  // A bad kind cannot produce an artifact name, so the spool refuses it.
  const { store, transitions } = fakeStore([claim({ kind: "laser" as never })]);

  const outcome = await runPrintWorkerOnce({
    store,
    spool,
    workerId: "w1",
    now: () => 1_800_000_000,
  });

  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.error_code, "PRINT_UNKNOWN_KIND");
  assert.equal(transitions[0]?.status, "failed");
  // The recorded error must be the code, not a message carrying a path.
  assert.equal(transitions[0]?.options?.error, "PRINT_UNKNOWN_KIND");
  assert.doesNotMatch(transitions[0]?.options?.error ?? "", /\//u);
});

test("a retry writes a distinct artifact per attempt", async () => {
  const spool = await tempSpool();
  const { store } = fakeStore([claim({ attempt_count: 1 }), claim({ attempt_count: 2 })]);

  const first = await runPrintWorkerOnce({
    store,
    spool,
    workerId: "w1",
    now: () => 1_800_000_000,
  });
  const second = await runPrintWorkerOnce({
    store,
    spool,
    workerId: "w1",
    now: () => 1_800_000_100,
  });

  assert.equal(first.kind === "printed" && first.artifact_path, `${JOB}-xp58-0001.txt`);
  assert.equal(second.kind === "printed" && second.artifact_path, `${JOB}-xp58-0002.txt`);
});

test("drain stops at the first idle step and respects its bound", async () => {
  const spool = await tempSpool();
  const { store } = fakeStore([
    claim({ job_id: "11111111-1111-4111-8111-111111111101" }),
    claim({ job_id: "11111111-1111-4111-8111-111111111102" }),
    null,
    claim({ job_id: "11111111-1111-4111-8111-111111111103" }),
  ]);

  const outcomes = await drainPrintQueue({
    store,
    spool,
    workerId: "w1",
    now: () => 1_800_000_000,
  });

  assert.equal(outcomes.length, 2, "drain must stop at the first idle result");
  assert.ok(outcomes.every((outcome) => outcome.kind === "printed"));
});

test("renderArtifact is a fixed template, not an interpreter", () => {
  const text = renderArtifact(claim({ ticket_no: "${danger}" }), 1_800_000_000);
  assert.match(text, /ticket {4}: \$\{danger\}/u, "input is copied verbatim, never evaluated");
  assert.match(text, /printed_at: 2027-01-15T/u);
});
