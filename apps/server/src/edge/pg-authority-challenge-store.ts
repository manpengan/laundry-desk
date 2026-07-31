import type {
  AuthorityStoreChallengeInput,
  AuthorityStoreChallengeResult,
  AuthorityStoreIssueInput,
} from "./authority-store.js";
import type { SqlClient } from "../db/types.js";

type ChallengeDeviceRow = Readonly<{
  public_key_spki: string;
  public_key_fingerprint: string;
  status: string;
}>;

type ConsumedChallengeRow = Readonly<{
  pairing_code_hash: string | null;
  pairing_code_required: boolean;
  expected_primary_epoch: string | number | null;
}>;

export type ConsumedAuthorityChallenge = Readonly<{
  pairingCodeHash: string | null;
  pairingCodeRequired: boolean;
  expectedPrimaryEpoch: number | null;
}>;

function parseDate(value: Date | string): Date {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError("Invalid PostgreSQL authority challenge expiry");
  }
  return parsed;
}

function parseEpoch(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError("Invalid PostgreSQL authority expected epoch");
  }
  return parsed;
}

async function loadChallengeDevice(
  client: SqlClient,
  input: AuthorityStoreChallengeInput,
): Promise<ChallengeDeviceRow | null> {
  const result = await client.query<ChallengeDeviceRow>(
    `SELECT public_key_spki, public_key_fingerprint, status
       FROM edge_devices
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND device_id = $3::uuid
      FOR UPDATE`,
    [input.orgId, input.storeId, input.deviceId],
  );
  if (result.rows.length > 1) throw new Error("PostgreSQL authority device identity is ambiguous");
  return result.rows[0] ?? null;
}

async function captureExpectedEpoch(
  client: SqlClient,
  input: AuthorityStoreChallengeInput,
): Promise<number | null> {
  if (!input.requestPrimary) return null;
  await client.query(
    `INSERT INTO primary_lease_heads (org_id, store_id, updated_at)
     VALUES ($1::uuid, $2::uuid, clock_timestamp())
     ON CONFLICT (org_id, store_id) DO NOTHING`,
    [input.orgId, input.storeId],
  );
  const result = await client.query<Readonly<{ current_epoch: string | number }>>(
    `SELECT current_epoch
       FROM primary_lease_heads
      WHERE org_id = $1::uuid AND store_id = $2::uuid`,
    [input.orgId, input.storeId],
  );
  const row = result.rows[0];
  if (result.rows.length !== 1 || row === undefined) {
    throw new Error("PostgreSQL Primary lease head is missing");
  }
  return parseEpoch(row.current_epoch);
}

export async function createPgAuthorityChallenge(
  client: SqlClient,
  input: AuthorityStoreChallengeInput,
): Promise<AuthorityStoreChallengeResult | null> {
  const device = await loadChallengeDevice(client, input);
  const pairingCodeRequired = device === null;
  if (pairingCodeRequired && !input.canPairDevice) return null;
  if (
    device !== null &&
    (device.status !== "paired" ||
      device.public_key_spki !== input.devicePublicKeySpki ||
      device.public_key_fingerprint !== input.devicePublicKeyFingerprint)
  ) {
    return null;
  }
  if (input.requestPrimary && !input.canPromotePrimary) return null;
  const expectedPrimaryEpoch = await captureExpectedEpoch(client, input);
  await client.query(
    `DELETE FROM edge_authority_challenges
      WHERE org_id = $1::uuid AND store_id = $2::uuid
        AND (device_id = $3::uuid OR consumed_at IS NOT NULL OR expires_at <= clock_timestamp())`,
    [input.orgId, input.storeId, input.deviceId],
  );
  const result = await client.query<Readonly<{ expires_at: Date | string }>>(
    `WITH trusted AS (SELECT clock_timestamp() AS now)
     INSERT INTO edge_authority_challenges (
       id, org_id, store_id, staff_id, session_id, session_version,
       permission_version, device_id, device_public_key_spki, device_public_key_fingerprint,
       challenge_sha256, request_nonce, request_primary, pairing_code_hash,
       pairing_code_required, expected_primary_epoch, actor_role, authentication_method,
       issued_at, expires_at
     )
     SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6,
            $7, $8::uuid, $9, $10, $11, $12::uuid, $13, $14, $15, $16, $17, $18,
            trusted.now, trusted.now + $19::int * interval '1 millisecond'
       FROM trusted
     ON CONFLICT DO NOTHING
     RETURNING expires_at`,
    [
      input.challengeId,
      input.orgId,
      input.storeId,
      input.staffId,
      input.sessionId,
      input.sessionVersion,
      input.permissionVersion,
      input.deviceId,
      input.devicePublicKeySpki,
      input.devicePublicKeyFingerprint,
      input.challengeSha256,
      input.requestNonce,
      input.requestPrimary,
      pairingCodeRequired ? input.pairingCodeHash : null,
      pairingCodeRequired,
      expectedPrimaryEpoch,
      input.role,
      input.authenticationMethod,
      input.ttlMs,
    ],
  );
  const row = result.rows[0];
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1 || row === undefined) {
    throw new Error("PostgreSQL authority challenge creation was ambiguous");
  }
  return Object.freeze({ expiresAt: parseDate(row.expires_at), pairingCodeRequired });
}

export async function consumePgAuthorityChallenge(
  client: SqlClient,
  input: AuthorityStoreIssueInput,
): Promise<ConsumedAuthorityChallenge | null> {
  const result = await client.query<ConsumedChallengeRow>(
    `UPDATE edge_authority_challenges
        SET consumed_at = clock_timestamp()
      WHERE id = $1::uuid
        AND org_id = $2::uuid AND store_id = $3::uuid
        AND staff_id = $4::uuid AND session_id = $5::uuid AND session_version = $6
        AND permission_version = $7 AND device_id = $8::uuid
        AND challenge_sha256 = $9
        AND request_nonce = $10::uuid
        AND request_primary = $11
        AND device_public_key_spki = $12
        AND device_public_key_fingerprint = $13
        AND actor_role = $14
        AND authentication_method = $15
        AND consumed_at IS NULL
        AND expires_at > clock_timestamp()
      RETURNING pairing_code_hash, pairing_code_required, expected_primary_epoch`,
    [
      input.challengeId,
      input.orgId,
      input.storeId,
      input.staffId,
      input.sessionId,
      input.sessionVersion,
      input.permissionVersion,
      input.deviceId,
      input.challengeSha256,
      input.requestNonce,
      input.requestPrimary,
      input.devicePublicKeySpki,
      input.devicePublicKeyFingerprint,
      input.role,
      input.authenticationMethod,
    ],
  );
  const row = result.rows[0];
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1 || row === undefined) {
    throw new Error("PostgreSQL authority challenge consumption was ambiguous");
  }
  return Object.freeze({
    pairingCodeHash: row.pairing_code_hash,
    pairingCodeRequired: row.pairing_code_required,
    expectedPrimaryEpoch: parseEpoch(row.expected_primary_epoch),
  });
}
