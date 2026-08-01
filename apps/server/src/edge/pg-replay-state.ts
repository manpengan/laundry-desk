import { z } from "zod";

import type { SqlClient } from "../db/types.js";
import type { PreparedPgReplay } from "./pg-replay.js";
import {
  replayCommandAllowed,
  storedGrantAllowsCommand,
  timestampInWindow,
} from "./replay-policy.js";

const AllowedCommandsSchema = z.array(z.string().min(1)).min(1);

type StaffRow = Readonly<{
  permission_version: number;
  role: string;
  is_privacy_admin: boolean;
}>;
type DeviceRow = Readonly<{ status: string; public_key_spki: string }>;
type GrantRow = Readonly<{
  permission_version: number;
  allowed_commands: unknown;
  issued_at: Date | string;
  not_after: Date | string;
  revoked_at: Date | string | null;
}>;

export type LockedReplayState = Readonly<{
  expectedSeq: number;
  currentEpoch: number | null;
  currentLeaseId: string | null;
  authorityCurrent: boolean;
}>;

async function lockSequenceState(client: SqlClient, prepared: PreparedPgReplay): Promise<number> {
  const authorization = prepared.request.payload.envelope.authorization;
  if (authorization.kind === "grant") {
    await client.query(
      `INSERT INTO offline_grant_replay_state (org_id, store_id, grant_id, last_seq, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 0, clock_timestamp())
       ON CONFLICT (org_id, store_id, grant_id) DO NOTHING`,
      [prepared.orgId, prepared.storeId, authorization.grant_id],
    );
    const state = await client.query<{ last_seq: string | number }>(
      `SELECT last_seq FROM offline_grant_replay_state
        WHERE org_id = $1::uuid AND store_id = $2::uuid AND grant_id = $3::uuid
        FOR UPDATE`,
      [prepared.orgId, prepared.storeId, authorization.grant_id],
    );
    return parseLastSequence(state.rows[0]?.last_seq);
  }

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
  return parseLastSequence(state.rows[0]?.last_seq);
}

function parseLastSequence(value: string | number | undefined): number {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Replay authority counter is invalid");
  }
  return sequence;
}

async function loadCurrentAuthority(
  client: SqlClient,
  prepared: PreparedPgReplay,
): Promise<Readonly<{ staff?: StaffRow; device?: DeviceRow; grant?: GrantRow }>> {
  const staff = await client.query<StaffRow>(
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
  const device = await client.query<DeviceRow>(
    `SELECT status, public_key_spki FROM edge_devices
        WHERE org_id = $1::uuid AND store_id = $2::uuid AND device_id = $3::uuid
        FOR UPDATE`,
    [prepared.orgId, prepared.storeId, prepared.deviceId],
  );
  const grant = await client.query<GrantRow>(
    `SELECT permission_version, allowed_commands, issued_at, not_after, revoked_at
         FROM offline_grants
        WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
          AND staff_id = $4::uuid AND device_id = $5::uuid`,
    [
      prepared.orgId,
      prepared.storeId,
      prepared.request.payload.envelope.authorization.grant_id,
      prepared.originalStaffId,
      prepared.deviceId,
    ],
  );
  return Object.freeze({
    ...(staff.rows[0] === undefined ? {} : { staff: staff.rows[0] }),
    ...(device.rows[0] === undefined ? {} : { device: device.rows[0] }),
    ...(grant.rows[0] === undefined ? {} : { grant: grant.rows[0] }),
  });
}

function grantIsCurrent(prepared: PreparedPgReplay, row: GrantRow | undefined): boolean {
  if (row === undefined) return false;
  const parsedCommands = AllowedCommandsSchema.safeParse(row.allowed_commands);
  const envelope = prepared.request.payload.envelope;
  const issuedAt = new Date(row.issued_at);
  const notAfter = new Date(row.not_after);
  return (
    row.permission_version === prepared.permissionVersion &&
    row.revoked_at === null &&
    parsedCommands.success &&
    replayCommandAllowed(prepared.authorizationKind, envelope.payload.command) &&
    storedGrantAllowsCommand(
      prepared.authorizationKind,
      parsedCommands.data,
      envelope.payload.command,
    ) &&
    prepared.grantWindowValid &&
    timestampInWindow(envelope.enqueued_at, issuedAt, notAfter)
  );
}

async function lockPrimary(
  client: SqlClient,
  prepared: PreparedPgReplay,
): Promise<Readonly<{ epoch: number; leaseId: string | null; leaseCurrent: boolean }>> {
  const authorization = prepared.request.payload.envelope.authorization;
  if (authorization.kind !== "primary_lease") {
    throw new Error("Primary authority required");
  }
  const head = await client.query<{
    current_epoch: string | number;
    current_lease_id: string | null;
  }>(
    `SELECT current_epoch, current_lease_id FROM primary_lease_heads
        WHERE org_id = $1::uuid AND store_id = $2::uuid FOR UPDATE`,
    [prepared.orgId, prepared.storeId],
  );
  const lease = await client.query<{
    device_id: string;
    primary_epoch: string | number;
    released_at: Date | string | null;
  }>(
    `SELECT device_id::text, primary_epoch, released_at FROM primary_leases
        WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
          AND grant_id = $4::uuid`,
    [prepared.orgId, prepared.storeId, authorization.lease_id, authorization.grant_id],
  );
  const headRow = head.rows[0];
  const leaseRow = lease.rows[0];
  const epoch = Number(headRow?.current_epoch);
  const leaseEpoch = Number(leaseRow?.primary_epoch);
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error("Replay Primary epoch is invalid");
  }
  return Object.freeze({
    epoch,
    leaseId: headRow?.current_lease_id ?? null,
    leaseCurrent:
      leaseRow !== undefined &&
      Number.isSafeInteger(leaseEpoch) &&
      leaseEpoch === authorization.primary_epoch &&
      leaseRow.device_id === prepared.deviceId &&
      leaseRow.released_at === null,
  });
}

export async function lockPgReplayState(
  client: SqlClient,
  prepared: PreparedPgReplay,
): Promise<LockedReplayState> {
  const lastSequence = await lockSequenceState(client, prepared);
  const current = await loadCurrentAuthority(client, prepared);
  const baseCurrent =
    current.staff?.permission_version === prepared.permissionVersion &&
    current.staff.role === prepared.role &&
    current.staff.is_privacy_admin === prepared.isPrivacyAdmin &&
    current.device?.status === "paired" &&
    current.device.public_key_spki === prepared.publicKeySpki &&
    grantIsCurrent(prepared, current.grant);

  if (prepared.authorizationKind === "grant") {
    return Object.freeze({
      expectedSeq: lastSequence + 1,
      currentEpoch: null,
      currentLeaseId: null,
      authorityCurrent: baseCurrent,
    });
  }

  const primary = await lockPrimary(client, prepared);
  return Object.freeze({
    expectedSeq: lastSequence + 1,
    currentEpoch: primary.epoch,
    currentLeaseId: primary.leaseId,
    authorityCurrent: baseCurrent && primary.leaseCurrent,
  });
}
