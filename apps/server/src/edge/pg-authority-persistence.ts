import { SignedPrimaryLeaseSchema } from "@laundry/contracts";

import { writeAudit } from "../audit/write-audit.js";
import type { SqlClient } from "../db/types.js";
import type {
  AuthorityStoreIssueInput,
  AuthorityStoreIssueResult,
  SignedPrimaryLease,
} from "./authority-store.js";

export type PgAuthorityDevice = Readonly<{
  public_key_spki: string;
  public_key_fingerprint: string;
  status: string;
}>;

export type PgPrimaryHead = Readonly<{
  current_epoch: string | number;
  current_lease_id: string | null;
}>;

type LeaseRow = Readonly<{
  id: string;
  grant_id: string;
  org_id: string;
  store_id: string;
  device_id: string;
  primary_epoch: string | number;
  protocol_version: string;
  signature: string;
  issued_at: Date | string;
  ttl_ms: string | number;
  max_clock_skew_ms: string | number;
  not_after: Date | string;
}>;

function parseDate(value: Date | string, field: string): Date {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError(`Invalid PostgreSQL authority ${field}`);
  }
  return parsed;
}

export function parseAuthorityInteger(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`Invalid PostgreSQL authority ${field}`);
  }
  return parsed;
}

export async function readAuthorityDatabaseNow(client: SqlClient): Promise<Date> {
  const result = await client.query<Readonly<{ now: Date | string }>>(
    "SELECT clock_timestamp() AS now",
  );
  const row = result.rows[0];
  if (result.rows.length !== 1 || row === undefined) {
    throw new Error("PostgreSQL authority clock returned no value");
  }
  return parseDate(row.now, "clock");
}

export async function lockPgAuthorityDevice(
  client: SqlClient,
  input: AuthorityStoreIssueInput,
): Promise<PgAuthorityDevice | null> {
  const result = await client.query<PgAuthorityDevice>(
    `SELECT public_key_spki, public_key_fingerprint, status
       FROM edge_devices
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND device_id = $3::uuid
      FOR UPDATE`,
    [input.orgId, input.storeId, input.deviceId],
  );
  if (result.rows.length > 1) {
    throw new Error("PostgreSQL authority device identity is ambiguous");
  }
  return result.rows[0] ?? null;
}

export function pgAuthorityDeviceMatches(
  input: AuthorityStoreIssueInput,
  device: PgAuthorityDevice,
): boolean {
  return (
    device.status === "paired" &&
    device.public_key_spki === input.devicePublicKeySpki &&
    device.public_key_fingerprint === input.devicePublicKeyFingerprint
  );
}

export async function bindPgAuthorityDevice(
  client: SqlClient,
  input: AuthorityStoreIssueInput,
  existing: PgAuthorityDevice | null,
): Promise<boolean> {
  let firstPair = false;
  if (existing === null) {
    const inserted = await client.query(
      `INSERT INTO edge_devices (
         org_id, store_id, device_id, public_key_spki, public_key_fingerprint,
         status, paired_by_staff_id, paired_at, last_seen_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, 'paired', $6::uuid,
         clock_timestamp(), clock_timestamp()
       )
       ON CONFLICT (org_id, store_id, device_id) DO NOTHING`,
      [
        input.orgId,
        input.storeId,
        input.deviceId,
        input.devicePublicKeySpki,
        input.devicePublicKeyFingerprint,
        input.staffId,
      ],
    );
    firstPair = inserted.rowCount === 1;
    const raced = await lockPgAuthorityDevice(client, input);
    if (raced === null || !pgAuthorityDeviceMatches(input, raced)) {
      throw new Error("PostgreSQL authority device binding conflicted");
    }
  }
  const updated = await client.query(
    `UPDATE edge_devices
        SET last_seen_at = clock_timestamp()
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND device_id = $3::uuid`,
    [input.orgId, input.storeId, input.deviceId],
  );
  if (updated.rowCount !== 1) {
    throw new Error("PostgreSQL authority device last-seen update failed");
  }
  return firstPair;
}

export async function lockPgPrimaryHead(
  client: SqlClient,
  input: AuthorityStoreIssueInput,
): Promise<PgPrimaryHead> {
  await client.query(
    `INSERT INTO primary_lease_heads (org_id, store_id, updated_at)
     VALUES ($1::uuid, $2::uuid, clock_timestamp())
     ON CONFLICT (org_id, store_id) DO NOTHING`,
    [input.orgId, input.storeId],
  );
  const result = await client.query<PgPrimaryHead>(
    `SELECT current_epoch, current_lease_id
       FROM primary_lease_heads
      WHERE org_id = $1::uuid AND store_id = $2::uuid
      FOR UPDATE`,
    [input.orgId, input.storeId],
  );
  const head = result.rows[0];
  if (result.rows.length !== 1 || head === undefined) {
    throw new Error("PostgreSQL Primary lease head is missing");
  }
  return head;
}

export async function loadPgPrimaryLease(
  client: SqlClient,
  input: AuthorityStoreIssueInput,
  leaseId: string,
): Promise<SignedPrimaryLease> {
  const result = await client.query<LeaseRow>(
    `SELECT id, grant_id, org_id, store_id, device_id, primary_epoch, protocol_version, signature,
            issued_at, ttl_ms, max_clock_skew_ms, not_after
       FROM primary_leases
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
    [input.orgId, input.storeId, leaseId],
  );
  const row = result.rows[0];
  if (result.rows.length !== 1 || row === undefined) {
    throw new Error("PostgreSQL Primary head references a missing lease");
  }
  return SignedPrimaryLeaseSchema.parse({
    protocol_version: row.protocol_version,
    payload: {
      lease_id: row.id,
      grant_id: row.grant_id,
      org_id: row.org_id,
      store_id: row.store_id,
      device_id: row.device_id,
      primary_epoch: parseAuthorityInteger(row.primary_epoch, "lease epoch"),
      issued_at: parseDate(row.issued_at, "lease issued_at").toISOString(),
      ttl_ms: parseAuthorityInteger(row.ttl_ms, "lease ttl"),
      max_clock_skew_ms: parseAuthorityInteger(row.max_clock_skew_ms, "lease skew"),
      not_after: parseDate(row.not_after, "lease not_after").toISOString(),
    },
    sig: row.signature,
  });
}

function assertGrantBinding(
  input: AuthorityStoreIssueInput,
  grant: AuthorityStoreIssueResult["offlineGrant"],
): void {
  const payload = grant.payload;
  if (
    payload.org_id !== input.orgId ||
    payload.store_id !== input.storeId ||
    payload.staff_id !== input.staffId ||
    payload.device_id !== input.deviceId ||
    payload.request_nonce !== input.requestNonce ||
    payload.permission_version !== input.permissionVersion
  ) {
    throw new TypeError("Signed offline grant does not match authority transaction");
  }
}

export async function persistPgOfflineGrant(
  client: SqlClient,
  input: AuthorityStoreIssueInput,
  grant: AuthorityStoreIssueResult["offlineGrant"],
): Promise<void> {
  assertGrantBinding(input, grant);
  await client.query(
    `INSERT INTO offline_grants (
       id, org_id, store_id, staff_id, device_id, request_nonce, permission_version,
       allowed_commands, protocol_version, signature, issued_at, not_after
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7,
       $8::jsonb, $9, $10, $11, $12
     )`,
    [
      grant.payload.grant_id,
      input.orgId,
      input.storeId,
      input.staffId,
      input.deviceId,
      input.requestNonce,
      input.permissionVersion,
      JSON.stringify(grant.payload.allowed_commands),
      grant.protocol_version,
      grant.sig,
      grant.payload.issued_at,
      grant.payload.not_after,
    ],
  );
}

export async function persistPgPrimaryLease(
  client: SqlClient,
  input: AuthorityStoreIssueInput,
  lease: SignedPrimaryLease,
  expectedEpoch: number,
  grantId: string,
): Promise<void> {
  if (
    lease.payload.org_id !== input.orgId ||
    lease.payload.store_id !== input.storeId ||
    lease.payload.device_id !== input.deviceId ||
    lease.payload.primary_epoch !== expectedEpoch ||
    lease.payload.grant_id !== grantId
  ) {
    throw new TypeError("Signed Primary lease does not match authority transaction");
  }
  await client.query(
    `INSERT INTO primary_leases (
       id, grant_id, org_id, store_id, device_id, primary_epoch, protocol_version,
       signature, issued_at, ttl_ms, max_clock_skew_ms, not_after
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, $10, $11, $12
     )`,
    [
      lease.payload.lease_id,
      lease.payload.grant_id,
      input.orgId,
      input.storeId,
      input.deviceId,
      lease.payload.primary_epoch,
      lease.protocol_version,
      lease.sig,
      lease.payload.issued_at,
      lease.payload.ttl_ms,
      lease.payload.max_clock_skew_ms,
      lease.payload.not_after,
    ],
  );
  const updated = await client.query(
    `UPDATE primary_lease_heads
        SET current_epoch = $3, current_lease_id = $4::uuid,
            current_device_id = $5::uuid, current_not_after = $6, updated_at = $7
      WHERE org_id = $1::uuid AND store_id = $2::uuid`,
    [
      input.orgId,
      input.storeId,
      lease.payload.primary_epoch,
      lease.payload.lease_id,
      input.deviceId,
      lease.payload.not_after,
      lease.payload.issued_at,
    ],
  );
  if (updated.rowCount !== 1) {
    throw new Error("PostgreSQL Primary lease head update failed");
  }
}

export async function appendPgAuthorityAudit(
  client: SqlClient,
  input: AuthorityStoreIssueInput,
  now: Date,
  command: "edge.device.pair" | "edge.primary.promote",
): Promise<void> {
  const afterJson =
    command === "edge.device.pair" ? '{"status":"paired"}' : '{"status":"primary_promoted"}';
  await writeAudit(client, {
    id: input.createAuditId(),
    orgId: input.orgId,
    storeId: input.storeId,
    staffId: input.staffId,
    via: "ui",
    command,
    idempotencyKey: null,
    dryRun: false,
    entity: "edge_device",
    entityId: input.deviceId,
    beforeJson: null,
    afterJson,
    ip: null,
    deviceId: input.deviceId,
    at: now,
  });
}
