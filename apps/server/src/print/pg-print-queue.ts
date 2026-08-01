import type { SqlClient } from "../db/types.js";
import { loadPgPrintSnapshot } from "./pg-print-snapshot.js";
import { hashPrintSnapshot } from "./snapshot.js";
import type {
  EnqueueOrderPrintJobInput,
  EnqueuePrintJobInput,
  PrintJobKind,
  PrintJobRecord,
  PrintJobStatus,
  RequeuePrintJobInput,
} from "./types.js";

function epochToDate(epoch: number): Date {
  return new Date(epoch * 1_000);
}

export async function enqueuePgDiagnosticJob(
  client: SqlClient,
  orgId: string,
  storeId: string,
  input: EnqueuePrintJobInput,
  createId: () => string,
): Promise<PrintJobRecord> {
  const now = input.now ?? Math.floor(Date.now() / 1_000);
  const jobId = input.job_id ?? createId();
  const at = epochToDate(now);
  await client.query(
    `INSERT INTO print_jobs (
       id, org_id, store_id, order_id, ticket_no, kind, status,
       error, payload_bytes, created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'queued',
       NULL, NULL, $7, $7
     )`,
    [jobId, orgId, storeId, input.order_id, input.ticket_no, input.kind, at],
  );
  return Object.freeze({
    job_id: jobId,
    kind: input.kind,
    status: "queued" as const,
    order_id: input.order_id,
    ticket_no: input.ticket_no,
    created_at: now,
    updated_at: now,
  });
}

export async function enqueuePgOrderJob(
  client: SqlClient,
  orgId: string,
  storeId: string,
  input: EnqueueOrderPrintJobInput,
  createId: () => string,
): Promise<PrintJobRecord> {
  const snapshot = await loadPgPrintSnapshot(client, orgId, storeId, input.order_id);
  if (snapshot === null) {
    throw new Error(`print order not found or not printable: ${input.order_id}`);
  }
  const now = input.now ?? Math.floor(Date.now() / 1_000);
  const jobId = input.job_id ?? createId();
  const at = epochToDate(now);
  await client.query(
    `INSERT INTO print_jobs (
       id, org_id, store_id, order_id, ticket_no, kind, status,
       error, payload_bytes, snapshot_json, snapshot_sha256, created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'queued',
       NULL, NULL, $7::jsonb, $8, $9, $9
     )`,
    [
      jobId,
      orgId,
      storeId,
      input.order_id,
      snapshot.ticket_no,
      input.kind,
      JSON.stringify(snapshot),
      hashPrintSnapshot(snapshot),
      at,
    ],
  );
  return Object.freeze({
    job_id: jobId,
    kind: input.kind,
    status: "queued" as const,
    order_id: input.order_id,
    ticket_no: snapshot.ticket_no,
    created_at: now,
    updated_at: now,
  });
}

export async function requeuePgPrintJob(
  client: SqlClient,
  orgId: string,
  storeId: string,
  input: RequeuePrintJobInput,
  createId: () => string,
): Promise<PrintJobRecord> {
  const sourceResult = await client.query<{
    order_id: string;
    kind: PrintJobKind;
    status: PrintJobStatus;
    snapshot_sha256: string | null;
  }>(
    `SELECT order_id::text, kind, status, snapshot_sha256
       FROM print_jobs
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      FOR SHARE`,
    [orgId, storeId, input.source_job_id],
  );
  const source = sourceResult.rows[0];
  if (source === undefined || source.snapshot_sha256 === null) {
    throw new Error(`print source not found or has no signed snapshot: ${input.source_job_id}`);
  }
  const eligible =
    input.action === "reprint"
      ? source.status === "done"
      : source.status === "failed" || source.status === "uncertain";
  if (!eligible) throw new Error(`print source status is not ${input.action} eligible`);
  const snapshot = await loadPgPrintSnapshot(client, orgId, storeId, source.order_id);
  if (snapshot === null) {
    throw new Error(`print order not found or not printable: ${source.order_id}`);
  }
  const snapshotSha256 = hashPrintSnapshot(snapshot);
  const jobId = input.job_id ?? createId();
  const now = input.now ?? Math.floor(Date.now() / 1_000);
  const at = epochToDate(now);
  await client.query(
    `INSERT INTO print_jobs (
       id, org_id, store_id, order_id, ticket_no, kind, status,
       error, payload_bytes, snapshot_json, snapshot_sha256, source_job_id,
       created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'queued',
       NULL, NULL, $7::jsonb, $8, $9::uuid, $10, $10
     )`,
    [
      jobId,
      orgId,
      storeId,
      source.order_id,
      snapshot.ticket_no,
      source.kind,
      JSON.stringify(snapshot),
      snapshotSha256,
      input.source_job_id,
      at,
    ],
  );
  return Object.freeze({
    job_id: jobId,
    kind: source.kind,
    status: "queued" as const,
    order_id: source.order_id,
    ticket_no: snapshot.ticket_no,
    created_at: now,
    updated_at: now,
  });
}
