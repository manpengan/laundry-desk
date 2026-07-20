/**
 * Local mock print queue (D4 half-step).
 * No contracts types yet — swap to packages/contracts when A4 freezes print_jobs.
 */

export type MockPrintStatus = "queued" | "printing" | "done" | "failed";

export type MockPrintJob = {
  id: string;
  kind: "xp58" | "dl206" | "gp3120" | "unknown";
  status: MockPrintStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
};

export type MockSpool = {
  jobs: MockPrintJob[];
};

let seq = 0;

export function createMockSpool(): MockSpool {
  return { jobs: [] };
}

/** Immutable enqueue: returns new spool + job. */
export function enqueue(
  spool: MockSpool,
  kind: MockPrintJob["kind"],
  now = Date.now(),
): { spool: MockSpool; job: MockPrintJob } {
  seq += 1;
  const job: MockPrintJob = {
    id: `mock-print-${seq}`,
    kind,
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  return { spool: { jobs: [...spool.jobs, job] }, job };
}

export function advanceJob(
  spool: MockSpool,
  id: string,
  status: MockPrintStatus,
  error?: string,
  now = Date.now(),
): MockSpool {
  return {
    jobs: spool.jobs.map((j) => {
      if (j.id !== id) return j;
      if (error !== undefined) {
        return { ...j, status, updatedAt: now, error };
      }
      return {
        id: j.id,
        kind: j.kind,
        status,
        createdAt: j.createdAt,
        updatedAt: now,
      };
    }),
  };
}

export function listJobs(spool: MockSpool): readonly MockPrintJob[] {
  return spool.jobs;
}
