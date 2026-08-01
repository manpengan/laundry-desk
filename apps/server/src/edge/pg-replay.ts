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
import { SERVER_EDGE_REPLAY_COMPATIBILITY_POLICY } from "./replay-compatibility.js";
import {
  grantCommandArgsAllowed,
  replayCommandAllowed,
  storedGrantAllowsCommand,
  timestampInWindow,
  type ReplayAuthorizationKind,
} from "./replay-policy.js";

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
  lease_grant_id: z.uuid().nullable(),
  lease_device_id: z.uuid().nullable(),
  lease_epoch: z.coerce.number().int().positive().nullable(),
  lease_issued_at: z.coerce.date().nullable(),
  lease_not_after: z.coerce.date().nullable(),
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
  authorizationKind: ReplayAuthorizationKind;
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
  grantWindowValid: boolean;
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
  const leaseId = authorization.kind === "primary_lease" ? authorization.lease_id : null;
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
           LEFT JOIN primary_leases lease_row
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
          leaseId,
        ],
      );
      if (result.rows.length !== 1) return null;
      const parsed = ActiveAuthorityRowSchema.safeParse(result.rows[0]);
      return parsed.success ? parsed.data : null;
    },
  );
}

function primaryMatches(request: EdgeReplayRequest, row: ActiveAuthorityRow): boolean {
  const authorization = request.payload.envelope.authorization;
  if (authorization.kind !== "primary_lease") return false;
  return (
    row.lease_grant_id === authorization.grant_id &&
    row.lease_device_id === request.payload.device_id &&
    row.lease_epoch === authorization.primary_epoch &&
    row.lease_issued_at !== null &&
    row.lease_not_after !== null &&
    timestampInWindow(
      request.payload.envelope.enqueued_at,
      row.lease_issued_at,
      row.lease_not_after,
    )
  );
}

function authorityMatchesRequest(request: EdgeReplayRequest, row: ActiveAuthorityRow): boolean {
  const envelope = request.payload.envelope;
  const kind = envelope.authorization.kind;
  if (!replayCommandAllowed(kind, envelope.payload.command)) return false;
  if (!storedGrantAllowsCommand(kind, row.allowed_commands, envelope.payload.command)) return false;
  if (kind === "grant") {
    if (envelope.payload.mode !== "direct") return false;
    if (!grantCommandArgsAllowed(envelope.payload.command, envelope.payload.args)) return false;
  }
  return kind === "grant" || primaryMatches(request, row);
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
  if (
    request.protocol_version !== "1.0.0" ||
    request.payload.device_id !== session.session.device_id
  ) {
    return null;
  }
  const row = await loadAuthority(pool, session, request);
  const grantWindowValid =
    row !== null &&
    timestampInWindow(envelope.enqueued_at, row.grant_issued_at, row.grant_not_after);
  if (
    row === null ||
    !authorityMatchesRequest(request, row) ||
    (envelope.authorization.kind === "primary_lease" && !grantWindowValid) ||
    !verifyRequestSignature(request, row.public_key_spki)
  ) {
    return null;
  }
  return Object.freeze({
    request,
    authorizationKind: envelope.authorization.kind,
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
    grantWindowValid,
  });
}
