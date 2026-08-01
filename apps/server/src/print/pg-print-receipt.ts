import {
  PrintReceiptSettlementSchema,
  SignedPrintExecutionReceiptSchema,
  canonicalizeExecutionReceiptForSigning,
  type PrintExecutionReceiptRequest,
  type PrintReceiptSettlement,
} from "@laundry/contracts";
import { createHash, verify } from "node:crypto";

import { writeAudit } from "../audit/write-audit.js";
import type { PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient } from "../db/types.js";
import { parseAuthorityDeviceKey } from "../edge/authority-crypto.js";
import { PrintDispatchError, type PrintDispatchSession } from "./dispatch-service.js";
import {
  lockPrintDevice,
  printDatabaseNow,
  printDispatchTenant,
  requirePairedPrintDevice,
} from "./pg-print-dispatch-shared.js";

const RECEIPT_ENVELOPE_DOMAIN = "laundry.edge.print-receipt-envelope.v1\n";

type ReceiptJobRow = Readonly<{
  id: string;
  status: string;
  dispatch_device_id: string | null;
  ticket_nonce: string | null;
  snapshot_sha256: string | null;
  receipt_seq: string | number | null;
  receipt_result: string | null;
  cups_job_id: string | null;
  receipt_envelope_sha256: string | null;
  settled_at: Date | null;
}>;

function receiptEnvelopeSha256(receipt: PrintExecutionReceiptRequest["receipt"]): string {
  const authority = Object.freeze({
    protocol_version: receipt.protocol_version,
    payload: receipt.payload,
  });
  return createHash("sha256")
    .update(RECEIPT_ENVELOPE_DOMAIN, "utf8")
    .update(canonicalizeExecutionReceiptForSigning(authority))
    .update("\0", "utf8")
    .update(receipt.sig, "utf8")
    .digest("hex");
}

function verifyReceipt(request: PrintExecutionReceiptRequest, publicKeySpki: string): void {
  const key = parseAuthorityDeviceKey(publicKeySpki);
  if (key === null) throw new PrintDispatchError("signature");
  const authority = Object.freeze({
    protocol_version: request.receipt.protocol_version,
    payload: request.receipt.payload,
  });
  const valid = verify(
    null,
    canonicalizeExecutionReceiptForSigning(authority),
    key.publicKey,
    Buffer.from(request.receipt.sig, "base64url"),
  );
  if (!valid) throw new PrintDispatchError("signature");
}

function terminalStatus(result: "succeeded" | "failed" | "uncertain") {
  return result === "succeeded" ? ("done" as const) : result;
}

function settledProjection(row: ReceiptJobRow, duplicate: boolean): PrintReceiptSettlement {
  if (
    row.settled_at === null ||
    (row.status !== "done" && row.status !== "failed" && row.status !== "uncertain") ||
    (row.receipt_result !== "succeeded" &&
      row.receipt_result !== "failed" &&
      row.receipt_result !== "uncertain")
  ) {
    throw new PrintDispatchError("collision");
  }
  return PrintReceiptSettlementSchema.parse({
    job_id: row.id,
    status: row.status,
    result: row.receipt_result,
    cups_job_id: row.cups_job_id,
    settled_at: row.settled_at.toISOString(),
    duplicate,
  });
}

async function lockReceiptJob(
  client: SqlClient,
  session: PrintDispatchSession,
  jobId: string,
): Promise<ReceiptJobRow> {
  const result = await client.query<ReceiptJobRow>(
    `SELECT id::text, status, dispatch_device_id::text, ticket_nonce::text,
            snapshot_sha256, receipt_seq, receipt_result, cups_job_id,
            receipt_envelope_sha256, settled_at
       FROM print_jobs
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      FOR UPDATE`,
    [session.orgId, session.storeId, jobId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new PrintDispatchError("binding");
  return row;
}

async function advanceReceiptHead(
  client: SqlClient,
  session: PrintDispatchSession,
  sequence: number,
  now: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO print_device_receipt_heads (org_id, store_id, device_id, last_seq, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 0, $4)
     ON CONFLICT (org_id, store_id, device_id) DO NOTHING`,
    [session.orgId, session.storeId, session.deviceId, now],
  );
  const current = await client.query<{ last_seq: string | number }>(
    `SELECT last_seq FROM print_device_receipt_heads
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND device_id = $3::uuid
      FOR UPDATE`,
    [session.orgId, session.storeId, session.deviceId],
  );
  const lastSequence = Number(current.rows[0]?.last_seq ?? -1);
  if (!Number.isSafeInteger(lastSequence) || sequence !== lastSequence + 1) {
    throw new PrintDispatchError("sequence");
  }
  const updated = await client.query(
    `UPDATE print_device_receipt_heads SET last_seq = $4, updated_at = $5
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND device_id = $3::uuid
        AND last_seq = $6`,
    [session.orgId, session.storeId, session.deviceId, sequence, now, lastSequence],
  );
  if (updated.rowCount !== 1) throw new PrintDispatchError("sequence");
}

function receiptError(status: "done" | "failed" | "uncertain"): string | null {
  if (status === "failed") return "Edge reported a pre-submit print failure";
  if (status === "uncertain") return "Edge reported an uncertain print outcome";
  return null;
}

export async function settlePgPrintReceipt(
  pool: PgPool,
  session: PrintDispatchSession,
  requestInput: PrintExecutionReceiptRequest,
  createAuditId: () => string,
): Promise<PrintReceiptSettlement> {
  const request = Object.freeze({
    receipt: SignedPrintExecutionReceiptSchema.parse(requestInput.receipt),
  });
  if (request.receipt.payload.device_id !== session.deviceId) {
    throw new PrintDispatchError("binding");
  }
  const envelopeSha256 = receiptEnvelopeSha256(request.receipt);
  return withPoolClient(pool, (sql) =>
    withTenantTransaction(sql, printDispatchTenant(session), async (client) => {
      const device = await lockPrintDevice(client, session);
      const payload = request.receipt.payload;
      const job = await lockReceiptJob(client, session, payload.job_id);
      // Exact replay is identified by immutable settled state and the full signed-envelope hash.
      // It must survive later device revocation or key rotation without re-verifying a stale key.
      if (job.receipt_envelope_sha256 !== null) {
        if (
          job.dispatch_device_id === session.deviceId &&
          job.receipt_envelope_sha256 === envelopeSha256
        ) {
          return settledProjection(job, true);
        }
        throw new PrintDispatchError("collision");
      }
      requirePairedPrintDevice(device);
      verifyReceipt(request, device.public_key_spki);
      if (
        job.status !== "printing" ||
        job.dispatch_device_id !== session.deviceId ||
        job.ticket_nonce !== payload.ticket_nonce ||
        job.snapshot_sha256 !== payload.snapshot_sha256
      ) {
        throw new PrintDispatchError("binding");
      }
      const now = await printDatabaseNow(client);
      await advanceReceiptHead(client, session, payload.seq, now);
      const status = terminalStatus(payload.result);
      const updated = await client.query<ReceiptJobRow>(
        `UPDATE print_jobs
            SET status = $4, error = $5, cups_job_id = $6,
                receipt_seq = $7, receipt_result = $8, receipt_at = $9,
                receipt_json = $10::jsonb, receipt_envelope_sha256 = $11,
                settled_at = $12, updated_at = $12,
                claimed_at = NULL, lease_until = NULL, worker_id = NULL,
                completed_at = CASE WHEN $4 = 'done' THEN $12 ELSE completed_at END
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
            AND status = 'printing' AND receipt_seq IS NULL
          RETURNING id::text, status, dispatch_device_id::text, ticket_nonce::text,
                    snapshot_sha256, receipt_seq, receipt_result, cups_job_id,
                    receipt_envelope_sha256, settled_at`,
        [
          session.orgId,
          session.storeId,
          payload.job_id,
          status,
          receiptError(status),
          payload.cups_job_id,
          payload.seq,
          payload.result,
          payload.at,
          JSON.stringify(request.receipt),
          envelopeSha256,
          now,
        ],
      );
      const settled = updated.rows[0];
      if (settled === undefined || updated.rowCount !== 1) {
        throw new PrintDispatchError("collision");
      }
      await writeAudit(client, {
        id: createAuditId(),
        orgId: session.orgId,
        storeId: session.storeId,
        staffId: session.staffId,
        via: "ui",
        command: "edge.print.receipt",
        idempotencyKey: null,
        dryRun: false,
        entity: "print_job",
        entityId: payload.job_id,
        beforeJson: '{"status":"printing"}',
        afterJson: JSON.stringify({
          status,
          result: payload.result,
          cups_job_id: payload.cups_job_id,
          receipt_seq: payload.seq,
          envelope_sha256: envelopeSha256,
        }),
        ip: null,
        deviceId: session.deviceId,
        at: now,
      });
      return settledProjection(settled, false);
    }),
  );
}
