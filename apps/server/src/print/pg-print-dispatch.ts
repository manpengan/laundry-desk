import {
  PrintDispatchDataSchema,
  PrintSnapshotSchema,
  type PrintDispatchClaimRequest,
  type PrintDispatchData,
} from "@laundry/contracts";
import { randomUUID, type KeyObject } from "node:crypto";

import type { PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient } from "../db/types.js";
import { signPrintCapabilityTicket } from "./capability-ticket.js";
import {
  PrintDispatchError,
  type PrintDispatchService,
  type PrintDispatchSession,
} from "./dispatch-service.js";
import {
  lockPrintDevice,
  printDatabaseNow,
  printDispatchTenant,
  requirePairedPrintDevice,
} from "./pg-print-dispatch-shared.js";
import { settlePgPrintReceipt } from "./pg-print-receipt.js";
import { hashPrintSnapshot } from "./snapshot.js";

const CAPABILITY_TTL_MS = 60_000;
/** Exact privileged Electron shell audience (`APP_HOST=local`). */
const PRINT_ORIGIN = "app://local";

type DispatchRow = Readonly<{
  id: string;
  kind: "xp58" | "dl206" | "gp3120";
  order_id: string;
  ticket_no: string;
  snapshot_json: unknown;
  snapshot_sha256: string;
  dispatch_staff_id: string | null;
  ticket_nonce: string | null;
}>;

export type CreatePgPrintDispatchServiceOptions = Readonly<{
  privateKey: KeyObject;
  capabilityTtlMs?: number;
  createNonce?: () => string;
  createAuditId?: () => string;
}>;

function parseBoundSnapshot(row: DispatchRow) {
  const snapshot = PrintSnapshotSchema.parse(row.snapshot_json);
  if (
    snapshot.order_id !== row.order_id ||
    snapshot.ticket_no !== row.ticket_no ||
    hashPrintSnapshot(snapshot) !== row.snapshot_sha256
  ) {
    throw new PrintDispatchError("binding");
  }
  return snapshot;
}

async function findExistingDispatch(
  client: SqlClient,
  session: PrintDispatchSession,
): Promise<DispatchRow | null> {
  const result = await client.query<DispatchRow>(
    `SELECT id::text, kind, order_id::text, ticket_no, snapshot_json,
            snapshot_sha256, dispatch_staff_id::text, ticket_nonce::text
       FROM print_jobs
      WHERE org_id = $1::uuid AND store_id = $2::uuid
        AND dispatch_device_id = $3::uuid AND status = 'printing'
        AND receipt_seq IS NULL
      ORDER BY created_at, id
      FOR UPDATE`,
    [session.orgId, session.storeId, session.deviceId],
  );
  if (result.rows.length > 1) throw new PrintDispatchError("collision");
  return result.rows[0] ?? null;
}

async function lockNextDispatch(
  client: SqlClient,
  session: PrintDispatchSession,
  request: PrintDispatchClaimRequest,
): Promise<DispatchRow | null> {
  const result = await client.query<DispatchRow>(
    `SELECT id::text, kind, order_id::text, ticket_no, snapshot_json,
            snapshot_sha256, dispatch_staff_id::text, ticket_nonce::text
       FROM print_jobs
      WHERE org_id = $1::uuid AND store_id = $2::uuid
        AND status = 'queued' AND snapshot_json IS NOT NULL
        AND snapshot_sha256 IS NOT NULL
        AND kind = ANY($3::text[])
      ORDER BY created_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1`,
    [session.orgId, session.storeId, request.supported_printer_kinds],
  );
  return result.rows[0] ?? null;
}

async function lockNextReceiptSequence(
  client: SqlClient,
  session: PrintDispatchSession,
  now: Date,
): Promise<number> {
  await client.query(
    `INSERT INTO print_device_receipt_heads (org_id, store_id, device_id, last_seq, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 0, $4)
     ON CONFLICT (org_id, store_id, device_id) DO NOTHING`,
    [session.orgId, session.storeId, session.deviceId, now],
  );
  const result = await client.query<{ last_seq: string | number }>(
    `SELECT last_seq FROM print_device_receipt_heads
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND device_id = $3::uuid
      FOR UPDATE`,
    [session.orgId, session.storeId, session.deviceId],
  );
  const lastSequence = Number(result.rows[0]?.last_seq ?? -1);
  if (!Number.isSafeInteger(lastSequence) || lastSequence < 0) {
    throw new PrintDispatchError("sequence");
  }
  const nextSequence = lastSequence + 1;
  if (!Number.isSafeInteger(nextSequence)) throw new PrintDispatchError("sequence");
  return nextSequence;
}

async function persistDispatch(
  client: SqlClient,
  session: PrintDispatchSession,
  row: DispatchRow,
  ticket: PrintDispatchData["capability_ticket"],
  now: Date,
  recovered: boolean,
): Promise<void> {
  const result = recovered
    ? await client.query(
        `UPDATE print_jobs
            SET capability_json = $5::jsonb, dispatch_issued_at = $6,
                dispatch_expires_at = $7, lease_until = $7, updated_at = $6
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
            AND status = 'printing' AND dispatch_device_id = $4::uuid
            AND receipt_seq IS NULL`,
        [
          session.orgId,
          session.storeId,
          row.id,
          session.deviceId,
          JSON.stringify(ticket),
          now,
          ticket.payload.exp,
        ],
      )
    : await client.query(
        `UPDATE print_jobs
            SET status = 'printing', attempt_count = attempt_count + 1,
                claimed_at = $6, lease_until = $7, worker_id = $8,
                dispatch_device_id = $4::uuid, dispatch_staff_id = $9::uuid,
                ticket_nonce = $10::uuid, capability_json = $5::jsonb,
                dispatch_issued_at = $6, dispatch_expires_at = $7, updated_at = $6
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
            AND status = 'queued' AND snapshot_json IS NOT NULL`,
        [
          session.orgId,
          session.storeId,
          row.id,
          session.deviceId,
          JSON.stringify(ticket),
          now,
          ticket.payload.exp,
          `edge:${session.deviceId}`,
          session.staffId,
          ticket.payload.nonce,
        ],
      );
  if (result.rowCount !== 1) throw new PrintDispatchError("collision");
}

export function createPgPrintDispatchService(
  pool: PgPool,
  options: CreatePgPrintDispatchServiceOptions,
): PrintDispatchService {
  const ttlMs = options.capabilityTtlMs ?? CAPABILITY_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 300_000) {
    throw new TypeError("Invalid print capability lifetime");
  }
  const createNonce = options.createNonce ?? randomUUID;
  const createAuditId = options.createAuditId ?? randomUUID;

  return Object.freeze({
    claim: async (session, request): Promise<PrintDispatchData | null> =>
      withPoolClient(pool, (sql) =>
        withTenantTransaction(sql, printDispatchTenant(session), async (client) => {
          const device = await lockPrintDevice(client, session);
          requirePairedPrintDevice(device);
          const existing = await findExistingDispatch(client, session);
          if (existing !== null && existing.dispatch_staff_id !== session.staffId) {
            throw new PrintDispatchError("binding");
          }
          if (existing !== null && !request.supported_printer_kinds.includes(existing.kind)) {
            throw new PrintDispatchError("binding");
          }
          const row = existing ?? (await lockNextDispatch(client, session, request));
          if (row === null) return null;
          const snapshot = parseBoundSnapshot(row);
          const nonce = existing === null ? createNonce() : row.ticket_nonce;
          if (nonce === null) throw new PrintDispatchError("binding");
          const now = await printDatabaseNow(client);
          const nextReceiptSequence = await lockNextReceiptSequence(client, session, now);
          const exp = new Date(now.getTime() + ttlMs);
          const capabilityTicket = signPrintCapabilityTicket(
            {
              action: "print_job",
              job_id: row.id,
              staff_id: session.staffId,
              device_id: session.deviceId,
              origin: PRINT_ORIGIN,
              printer_kind: row.kind,
              snapshot_sha256: row.snapshot_sha256,
              recovered: existing !== null,
              next_receipt_seq: nextReceiptSequence,
              issued_at: now.toISOString(),
              exp: exp.toISOString(),
              nonce,
            },
            options.privateKey,
          );
          const data = PrintDispatchDataSchema.parse({
            capability_ticket: capabilityTicket,
            snapshot,
          });
          await persistDispatch(
            client,
            session,
            row,
            data.capability_ticket,
            now,
            existing !== null,
          );
          return data;
        }),
      ),

    settle: async (session, requestInput) =>
      settlePgPrintReceipt(pool, session, requestInput, createAuditId),
  });
}
