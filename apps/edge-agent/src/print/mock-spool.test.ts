import assert from "node:assert/strict";
import test from "node:test";
import { advanceJob, createMockSpool, enqueue, listJobs } from "./mock-spool.js";

test("enqueue then advance to done", () => {
  const empty = createMockSpool();
  const { spool, job } = enqueue(empty, "xp58", 1000);
  assert.equal(job.status, "queued");
  assert.equal(listJobs(spool).length, 1);

  const done = advanceJob(spool, job.id, "done", undefined, 2000);
  assert.equal(done.jobs[0]?.status, "done");
  assert.equal(done.jobs[0]?.updatedAt, 2000);
});

test("failed jobs keep error text", () => {
  const { spool, job } = enqueue(createMockSpool(), "dl206", 1);
  const failed = advanceJob(spool, job.id, "failed", "spool offline", 2);
  assert.equal(failed.jobs[0]?.status, "failed");
  assert.equal(failed.jobs[0]?.error, "spool offline");
});
