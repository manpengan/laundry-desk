/**
 * XP-58 process path: queued → printing → done|failed with ESC/POS bytes.
 * Mock device success (no USB). Pure orchestration over PrintJobStore.
 */

import { buildXp58EscPosFromTicket } from "./escpos-xp58.js";
import type { PrintJobRecord, PrintJobStore } from "./types.js";

export type ProcessXp58Result = Readonly<{
  job: PrintJobRecord;
  payload_bytes: number;
}>;

export type ProcessXp58Options = Readonly<{
  now?: number;
  /** Optional body lines; default template uses ticket_no only. */
  lines?: readonly string[];
}>;

/**
 * Process a single queued XP-58 job.
 * Throws if job missing, wrong kind, or illegal transition.
 * On ESC/POS build failure: marks failed and rethrows with cause preserved via error text.
 */
export async function processXp58PrintJob(
  store: PrintJobStore,
  jobId: string,
  options: ProcessXp58Options = {},
): Promise<ProcessXp58Result> {
  const job = await store.get(jobId);
  if (job === null) {
    throw new Error(`print job not found: ${jobId}`);
  }
  if (job.kind !== "xp58") {
    throw new Error(`print job ${jobId} kind ${job.kind} is not xp58`);
  }
  if (job.status !== "queued") {
    throw new Error(`print job ${jobId} is not queued (status=${job.status})`);
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  await store.transition(jobId, "printing", { now });

  try {
    const bytes = buildXp58EscPosFromTicket(job.ticket_no, options.lines);
    const payloadBytes = bytes.byteLength;
    const done = await store.transition(jobId, "done", {
      now: now + 1,
      payload_bytes: payloadBytes,
    });
    return Object.freeze({ job: done, payload_bytes: payloadBytes });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const text = message.length > 0 ? message : "escpos build failed";
    await store.transition(jobId, "failed", { now: now + 1, error: text });
    throw err;
  }
}
