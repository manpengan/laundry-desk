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

type IdempotentPrintJobRow = Readonly<{
  id: string;
  kind: PrintJobKind;
  status: PrintJobStatus;
  order_id: string;
  ticket_no: string;
  created_at: Date;
  updated_at: Date;
  error: string | null;
  payload_bytes: number | null;
  snapshot_sha256: string | null;
  source_job_id: string | null;
  idempotency_key: string | null;
}>;

const IDEMPOTENT_JOB_COLUMNS = `id::text, kind, status, order_id::text, ticket_no,
  created_at, updated_at, error, payload_bytes, snapshot_sha256,
  source_job_id::text, idempotency_key`;

function mapIdempotentJob(row: IdempotentPrintJobRow): PrintJobRecord {
  return Object.freeze({
    job_id: row.id,
    kind: row.kind,
    status: row.status,
    order_id: row.order_id,
    ticket_no: row.ticket_no,
    created_at: Math.floor(row.created_at.getTime() / 1_000),
    updated_at: Math.floor(row.updated_at.getTime() / 1_000),
    ...(row.error !== null && row.error.length > 0 ? { error: row.error } : {}),
    ...(row.payload_bytes !== null ? { payload_bytes: row.payload_bytes } : {}),
  });
}

function rootIdempotencyKey(orderId: string, kind: PrintJobKind): string {
  return `root:${orderId}:${kind}`;
}

function childIdempotencyKey(sourceJobId: string): string {
  return `child:${sourceJobId}`;
}

async function selectIdempotentJob(
  client: SqlClient,
  orgId: string,
  storeId: string,
  key: string,
): Promise<IdempotentPrintJobRow | null> {
  const result = await client.query<IdempotentPrintJobRow>(
    `SELECT ${IDEMPOTENT_JOB_COLUMNS}
       FROM print_jobs
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND idempotency_key = $3`,
    [orgId, storeId, key],
  );
  return result.rows[0] ?? null;
}

function assertRootAuthority(
  row: IdempotentPrintJobRow,
  input: EnqueueOrderPrintJobInput,
  key: string,
): void {
  if (
    row.idempotency_key !== key ||
    row.source_job_id !== null ||
    row.snapshot_sha256 === null ||
    row.order_id !== input.order_id ||
    row.kind !== input.kind
  ) {
    throw new Error("PRINT_JOB_IDEMPOTENCY_BINDING_INVALID");
  }
}

function assertChildAuthority(
  row: IdempotentPrintJobRow,
  source: Readonly<{ order_id: string; kind: PrintJobKind }>,
  sourceJobId: string,
  key: string,
): void {
  if (
    row.idempotency_key !== key ||
    row.source_job_id !== sourceJobId ||
    row.snapshot_sha256 === null ||
    row.order_id !== source.order_id ||
    row.kind !== source.kind
  ) {
    throw new Error("PRINT_JOB_IDEMPOTENCY_BINDING_INVALID");
  }
}

async function assertNoLegacyAuthority(
  client: SqlClient,
  orgId: string,
  storeId: string,
  predicate: Readonly<{ orderId: string; kind: PrintJobKind }> | Readonly<{ sourceJobId: string }>,
): Promise<void> {
  const root = "orderId" in predicate;
  const result = await client.query<{ present: boolean }>(
    root
      ? `SELECT EXISTS (
           SELECT 1 FROM print_jobs
            WHERE org_id = $1::uuid AND store_id = $2::uuid
              AND order_id = $3::uuid AND kind = $4 AND source_job_id IS NULL
              AND snapshot_sha256 IS NOT NULL AND idempotency_key IS NULL
         ) AS present`
      : `SELECT EXISTS (
           SELECT 1 FROM print_jobs
            WHERE org_id = $1::uuid AND store_id = $2::uuid
              AND source_job_id = $3::uuid
              AND snapshot_sha256 IS NOT NULL AND idempotency_key IS NULL
         ) AS present`,
    root
      ? [orgId, storeId, predicate.orderId, predicate.kind]
      : [orgId, storeId, predicate.sourceJobId],
  );
  if (result.rows[0]?.present === true) {
    throw new Error("PRINT_JOB_IDEMPOTENCY_AUTHORITY_AMBIGUOUS");
  }
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
  const idempotencyKey = rootIdempotencyKey(input.order_id, input.kind);
  const existing = await selectIdempotentJob(client, orgId, storeId, idempotencyKey);
  if (existing !== null) {
    assertRootAuthority(existing, input, idempotencyKey);
    return mapIdempotentJob(existing);
  }
  await assertNoLegacyAuthority(client, orgId, storeId, {
    orderId: input.order_id,
    kind: input.kind,
  });
  const snapshot = await loadPgPrintSnapshot(client, orgId, storeId, input.order_id);
  if (snapshot === null) {
    throw new Error(`print order not found or not printable: ${input.order_id}`);
  }
  const now = input.now ?? Math.floor(Date.now() / 1_000);
  const jobId = input.job_id ?? createId();
  const at = epochToDate(now);
  const inserted = await client.query<IdempotentPrintJobRow>(
    `INSERT INTO print_jobs (
       id, org_id, store_id, order_id, ticket_no, kind, status,
       error, payload_bytes, snapshot_json, snapshot_sha256, idempotency_key,
       created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'queued',
       NULL, NULL, $7::jsonb, $8, $9, $10, $10
     )
     ON CONFLICT (org_id, store_id, idempotency_key)
       WHERE idempotency_key IS NOT NULL
     DO NOTHING
     RETURNING ${IDEMPOTENT_JOB_COLUMNS}`,
    [
      jobId,
      orgId,
      storeId,
      input.order_id,
      snapshot.ticket_no,
      input.kind,
      JSON.stringify(snapshot),
      hashPrintSnapshot(snapshot),
      idempotencyKey,
      at,
    ],
  );
  const authority =
    inserted.rows[0] ?? (await selectIdempotentJob(client, orgId, storeId, idempotencyKey));
  if (authority === null) throw new Error("PRINT_JOB_IDEMPOTENCY_AUTHORITY_MISSING");
  assertRootAuthority(authority, input, idempotencyKey);
  return mapIdempotentJob(authority);
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
  const idempotencyKey = childIdempotencyKey(input.source_job_id);
  const existing = await selectIdempotentJob(client, orgId, storeId, idempotencyKey);
  if (existing !== null) {
    assertChildAuthority(existing, source, input.source_job_id, idempotencyKey);
    return mapIdempotentJob(existing);
  }
  await assertNoLegacyAuthority(client, orgId, storeId, {
    sourceJobId: input.source_job_id,
  });
  const snapshot = await loadPgPrintSnapshot(client, orgId, storeId, source.order_id);
  if (snapshot === null) {
    throw new Error(`print order not found or not printable: ${source.order_id}`);
  }
  const snapshotSha256 = hashPrintSnapshot(snapshot);
  const jobId = input.job_id ?? createId();
  const now = input.now ?? Math.floor(Date.now() / 1_000);
  const at = epochToDate(now);
  const inserted = await client.query<IdempotentPrintJobRow>(
    `INSERT INTO print_jobs (
       id, org_id, store_id, order_id, ticket_no, kind, status,
       error, payload_bytes, snapshot_json, snapshot_sha256, source_job_id,
       idempotency_key, created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'queued',
       NULL, NULL, $7::jsonb, $8, $9::uuid, $10, $11, $11
     )
     ON CONFLICT (org_id, store_id, idempotency_key)
       WHERE idempotency_key IS NOT NULL
     DO NOTHING
     RETURNING ${IDEMPOTENT_JOB_COLUMNS}`,
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
      idempotencyKey,
      at,
    ],
  );
  const authority =
    inserted.rows[0] ?? (await selectIdempotentJob(client, orgId, storeId, idempotencyKey));
  if (authority === null) throw new Error("PRINT_JOB_IDEMPOTENCY_AUTHORITY_MISSING");
  assertChildAuthority(authority, source, input.source_job_id, idempotencyKey);
  return mapIdempotentJob(authority);
}
