import { createHash, createPublicKey, verify } from "node:crypto";

import {
  canonicalizeEdgeReplayForSigning,
  classifyQueueEnvelopeCompatibility,
  type EdgeReplayRequest,
} from "@laundry/contracts";
import { z } from "zod";

import type { AuthorizedSession } from "../auth/session-view.js";
import type { PgPool } from "../db/pg-pool.js";
import { withStoreGuc } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
import { SERVER_EDGE_REPLAY_COMPATIBILITY_POLICY } from "./replay-compatibility.js";

const AllowedCommandsSchema = z.array(z.string().min(1)).min(1);
const ActiveAuthorityRowSchema = z.strictObject({
  public_key_spki: z.string(),
  device_status: z.enum(["paired", "revoked"]),
  original_staff_id: z.uuid(),
  grant_permission_version: z.coerce.number().int().positive(),
  allowed_commands: AllowedCommandsSchema,
  grant_issued_at: z.coerce.date(),
  grant_not_after: z.coerce.date(),
  grant_revoked_at: z.coerce.date().nullable(),
  lease_grant_id: z.uuid(),
  lease_device_id: z.uuid(),
  lease_epoch: z.coerce.number().int().positive(),
  lease_issued_at: z.coerce.date(),
  lease_not_after: z.coerce.date(),
  lease_released_at: z.coerce.date().nullable(),
  current_permission_version: z.coerce.number().int().positive(),
  staff_active: z.boolean(),
  role: z.enum(["admin", "staff"]),
  role_active: z.boolean(),
  is_privacy_admin: z.boolean(),
});

type ActiveAuthorityRow = z.output<typeof ActiveAuthorityRowSchema>;

export type PreparedPgReplay = Readonly<{
  request: EdgeReplayRequest;
  orgId: string;
  storeId: string;
  originalStaffId: string;
  replayedByStaffId: string;
  deviceId: string;
  permissionVersion: number;
  role: "admin" | "staff";
  isPrivacyAdmin: boolean;
  envelopeSha256: string;
  publicKeySpki: string;
}>;

function replayAuthority(request: EdgeReplayRequest) {
  return Object.freeze({
    protocol_version: request.protocol_version,
    payload: request.payload,
  });
}

function verifyRequestSignature(request: EdgeReplayRequest, publicKeySpki: string): boolean {
  try {
    const bytes = Buffer.from(publicKeySpki, "base64url");
    if (bytes.toString("base64url") !== publicKeySpki) return false;
    const publicKey = createPublicKey({ key: bytes, format: "der", type: "spki" });
    return (
      publicKey.asymmetricKeyType === "ed25519" &&
      verify(
        null,
        canonicalizeEdgeReplayForSigning(replayAuthority(request)),
        publicKey,
        Buffer.from(request.sig, "base64url"),
      )
    );
  } catch {
    return false;
  }
}

async function loadAuthority(
  pool: PgPool,
  session: AuthorizedSession,
  request: EdgeReplayRequest,
): Promise<ActiveAuthorityRow | null> {
  const authorization = request.payload.envelope.authorization;
  if (authorization.kind !== "primary_lease") return null;
  return withStoreGuc(
    pool,
    {
      orgId: session.session.org_id,
      storeId: session.session.store_id,
      staffId: session.session.staff_id,
    },
    async (client) => {
      const result = await client.query(
        `SELECT device.public_key_spki, device.status AS device_status,
                grant_row.staff_id::text AS original_staff_id,
                grant_row.permission_version AS grant_permission_version,
                grant_row.allowed_commands, grant_row.issued_at AS grant_issued_at,
                grant_row.not_after AS grant_not_after, grant_row.revoked_at AS grant_revoked_at,
                lease_row.grant_id::text AS lease_grant_id,
                lease_row.device_id::text AS lease_device_id,
                lease_row.primary_epoch AS lease_epoch,
                lease_row.issued_at AS lease_issued_at,
                lease_row.not_after AS lease_not_after,
                lease_row.released_at AS lease_released_at,
                staff_row.permission_version AS current_permission_version,
                staff_row.is_active AS staff_active,
                role_row.role, role_row.is_active AS role_active,
                role_row.is_privacy_admin
           FROM offline_grants grant_row
           JOIN edge_devices device
             ON device.org_id = grant_row.org_id
            AND device.store_id = grant_row.store_id
            AND device.device_id = grant_row.device_id
           JOIN primary_leases lease_row
            ON lease_row.org_id = grant_row.org_id
            AND lease_row.store_id = grant_row.store_id
            AND lease_row.grant_id = grant_row.id
            AND lease_row.device_id = grant_row.device_id
            AND lease_row.id = $5::uuid
           JOIN staffs staff_row
             ON staff_row.org_id = grant_row.org_id
            AND staff_row.id = grant_row.staff_id
           JOIN staff_store_roles role_row
             ON role_row.org_id = grant_row.org_id
            AND role_row.store_id = grant_row.store_id
            AND role_row.staff_id = grant_row.staff_id
          WHERE grant_row.org_id = $1::uuid
            AND grant_row.store_id = $2::uuid
            AND grant_row.id = $3::uuid
            AND grant_row.device_id = $4::uuid`,
        [
          session.session.org_id,
          session.session.store_id,
          authorization.grant_id,
          session.session.device_id,
          authorization.lease_id,
        ],
      );
      if (result.rows.length !== 1) return null;
      const parsed = ActiveAuthorityRowSchema.safeParse(result.rows[0]);
      return parsed.success ? parsed.data : null;
    },
  );
}

function timeContains(enqueuedAt: string, issuedAt: Date, notAfter: Date): boolean {
  const enqueued = Date.parse(enqueuedAt);
  return (
    Number.isFinite(enqueued) && enqueued >= issuedAt.getTime() && enqueued <= notAfter.getTime()
  );
}

export async function preparePgReplay(
  pool: PgPool,
  session: AuthorizedSession,
  request: EdgeReplayRequest,
): Promise<PreparedPgReplay | null> {
  const envelope = request.payload.envelope;
  if (
    classifyQueueEnvelopeCompatibility(envelope, SERVER_EDGE_REPLAY_COMPATIBILITY_POLICY).mode !==
    "replay"
  ) {
    return null;
  }
  const authorization = envelope.authorization;
  if (
    request.protocol_version !== "1.0.0" ||
    request.payload.device_id !== session.session.device_id ||
    authorization.kind !== "primary_lease"
  ) {
    return null;
  }
  const row = await loadAuthority(pool, session, request);
  if (
    row === null ||
    row.lease_grant_id !== authorization.grant_id ||
    row.lease_device_id !== session.session.device_id ||
    row.lease_epoch !== authorization.primary_epoch ||
    !row.allowed_commands.includes(envelope.payload.command) ||
    !timeContains(envelope.enqueued_at, row.grant_issued_at, row.grant_not_after) ||
    !timeContains(envelope.enqueued_at, row.lease_issued_at, row.lease_not_after) ||
    !verifyRequestSignature(request, row.public_key_spki)
  ) {
    return null;
  }
  return Object.freeze({
    request,
    orgId: session.session.org_id,
    storeId: session.session.store_id,
    originalStaffId: row.original_staff_id,
    replayedByStaffId: session.session.staff_id,
    deviceId: session.session.device_id,
    permissionVersion: row.grant_permission_version,
    role: row.role,
    isPrivacyAdmin: row.is_privacy_admin,
    envelopeSha256: createHash("sha256")
      .update(canonicalizeEdgeReplayForSigning(replayAuthority(request)))
      .digest("hex"),
    publicKeySpki: row.public_key_spki,
  });
}

export type LockedReplayState = Readonly<{
  expectedSeq: number;
  currentEpoch: number;
  currentLeaseId: string | null;
  authorityCurrent: boolean;
}>;

export async function lockPgReplayState(
  client: SqlClient,
  prepared: PreparedPgReplay,
): Promise<LockedReplayState> {
  const authorization = prepared.request.payload.envelope.authorization;
  if (authorization.kind !== "primary_lease") throw new Error("Primary lease replay required");
  const staff = await client.query<{
    permission_version: number;
    role: string;
    is_privacy_admin: boolean;
  }>(
    `SELECT staff_row.permission_version, role_row.role, role_row.is_privacy_admin
       FROM staffs staff_row
       JOIN staff_store_roles role_row
         ON role_row.org_id = staff_row.org_id AND role_row.staff_id = staff_row.id
      WHERE staff_row.org_id = $1::uuid AND staff_row.id = $3::uuid
        AND role_row.store_id = $2::uuid
        AND staff_row.is_active = true AND role_row.is_active = true
      FOR UPDATE OF staff_row, role_row`,
    [prepared.orgId, prepared.storeId, prepared.originalStaffId],
  );
  const device = await client.query<{ status: string; public_key_spki: string }>(
    `SELECT status, public_key_spki FROM edge_devices
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND device_id = $3::uuid
      FOR UPDATE`,
    [prepared.orgId, prepared.storeId, prepared.deviceId],
  );
  const grant = await client.query<{
    permission_version: number;
    allowed_commands: unknown;
    revoked_at: Date | string | null;
  }>(
    `SELECT permission_version, allowed_commands, revoked_at FROM offline_grants
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND staff_id = $4::uuid AND device_id = $5::uuid`,
    [
      prepared.orgId,
      prepared.storeId,
      authorization.grant_id,
      prepared.originalStaffId,
      prepared.deviceId,
    ],
  );
  const head = await client.query<{
    current_epoch: string | number;
    current_lease_id: string | null;
  }>(
    `SELECT current_epoch, current_lease_id FROM primary_lease_heads
      WHERE org_id = $1::uuid AND store_id = $2::uuid FOR UPDATE`,
    [prepared.orgId, prepared.storeId],
  );
  const lease = await client.query<{ released_at: Date | string | null }>(
    `SELECT released_at FROM primary_leases
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND grant_id = $4::uuid`,
    [prepared.orgId, prepared.storeId, authorization.lease_id, authorization.grant_id],
  );
  await client.query(
    `INSERT INTO primary_lease_replay_state (org_id, store_id, lease_id, last_seq, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 0, clock_timestamp())
     ON CONFLICT (org_id, store_id, lease_id) DO NOTHING`,
    [prepared.orgId, prepared.storeId, authorization.lease_id],
  );
  const state = await client.query<{ last_seq: string | number }>(
    `SELECT last_seq FROM primary_lease_replay_state
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND lease_id = $3::uuid
      FOR UPDATE`,
    [prepared.orgId, prepared.storeId, authorization.lease_id],
  );
  const staffRow = staff.rows[0];
  const deviceRow = device.rows[0];
  const grantRow = grant.rows[0];
  const headRow = head.rows[0];
  const stateRow = state.rows[0];
  if (headRow === undefined || stateRow === undefined || lease.rows.length !== 1) {
    throw new Error("Replay authority state disappeared");
  }
  const currentEpoch = Number(headRow.current_epoch);
  const lastSeq = Number(stateRow.last_seq);
  if (!Number.isSafeInteger(currentEpoch) || !Number.isSafeInteger(lastSeq)) {
    throw new Error("Replay authority counters are invalid");
  }
  const authorityCurrent =
    staffRow !== undefined &&
    staffRow.permission_version === prepared.permissionVersion &&
    staffRow.role === prepared.role &&
    staffRow.is_privacy_admin === prepared.isPrivacyAdmin &&
    deviceRow?.status === "paired" &&
    deviceRow.public_key_spki === prepared.publicKeySpki &&
    grantRow?.permission_version === prepared.permissionVersion &&
    grantRow.revoked_at === null &&
    AllowedCommandsSchema.safeParse(grantRow.allowed_commands).success &&
    AllowedCommandsSchema.parse(grantRow.allowed_commands).includes(
      prepared.request.payload.envelope.payload.command,
    ) &&
    lease.rows[0]?.released_at === null;
  return Object.freeze({
    expectedSeq: lastSeq + 1,
    currentEpoch,
    currentLeaseId: headRow.current_lease_id,
    authorityCurrent,
  });
}
