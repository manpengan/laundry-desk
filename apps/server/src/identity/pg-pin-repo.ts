/**
 * PIN challenge / lockout repos for PG identity (GUC writes + definer reads).
 */

import type { PgPool } from "../db/pg-pool.js";
import { withStoreGuc } from "../db/tenant-guc-client.js";
import { epochToDate, mapPin, pinStatusToSql, type PinRow } from "./pg-store-mappers.js";
import type {
  PinChallengeRepository,
  PinLockoutRecord,
  PinLockoutRepository,
  Uuid,
} from "./types.js";

const lockoutKey = (orgId: Uuid, storeId: Uuid, staffId: Uuid, deviceId: Uuid): string =>
  `${orgId}|${storeId}|${staffId}|${deviceId}`;

export function createPinChallengeRepo(pool: PgPool): PinChallengeRepository {
  return Object.freeze({
    get: async (challengeId) => {
      const result = await pool.query<PinRow>(
        `SELECT id::text, org_id::text, store_id::text, device_id::text,
                session_id::text, session_version, purpose,
                target_staff_id::text, approver_staff_id::text,
                pending_action_ref, nonce, attempts, max_attempts,
                status, issued_at, expires_at, requester_staff_id::text
         FROM laundry_auth_lookup_pin($1::uuid)`,
        [challengeId],
      );
      const row = result.rows[0];
      return row === undefined ? null : mapPin(row);
    },
    insert: async (challenge) => {
      await withStoreGuc(
        pool,
        {
          orgId: challenge.org_id,
          storeId: challenge.store_id,
          staffId: challenge.requester_staff_id,
        },
        async (client) => {
          await client.query(
            `INSERT INTO pin_challenges (
               id, org_id, store_id, device_id, session_id, session_version,
               purpose, target_staff_id, approver_staff_id, pending_action_ref,
               nonce, attempts, max_attempts, status, issued_at, expires_at, consumed_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
            [
              challenge.challenge_id,
              challenge.org_id,
              challenge.store_id,
              challenge.device_id,
              challenge.session_id,
              challenge.session_version,
              challenge.purpose,
              challenge.target_staff_id ?? null,
              challenge.approver_staff_id ?? null,
              challenge.pending_action_ref ?? null,
              challenge.nonce,
              challenge.failed_attempts,
              challenge.max_attempts,
              pinStatusToSql(challenge.status),
              epochToDate(challenge.issued_at),
              epochToDate(challenge.expires_at),
              challenge.status === "consumed" ? epochToDate(challenge.issued_at) : null,
            ],
          );
        },
      );
    },
    casUpdate: async (challengeId, expectedFailed, next) => {
      const looked = await pool.query<{ org_id: string; store_id: string }>(
        `SELECT org_id::text, store_id::text FROM laundry_auth_lookup_pin($1::uuid)`,
        [challengeId],
      );
      const tenant = looked.rows[0];
      if (tenant === undefined) return 0;
      const sqlStatus =
        next.status === "consumed" && next.failed_attempts >= 5
          ? "exhausted"
          : pinStatusToSql(next.status);
      return withStoreGuc(
        pool,
        { orgId: tenant.org_id, storeId: tenant.store_id },
        async (client) => {
          const result = await client.query(
            `UPDATE pin_challenges
             SET attempts = $3, status = $4,
                 consumed_at = CASE WHEN $4 IN ('consumed','exhausted') THEN NOW() ELSE consumed_at END
             WHERE id = $1 AND status = 'open' AND attempts = $2`,
            [challengeId, expectedFailed, next.failed_attempts, sqlStatus],
          );
          return (result.rowCount ?? 0) > 0 ? 1 : 0;
        },
      );
    },
  });
}

export function createPinLockoutRepo(): PinLockoutRepository {
  const lockouts = new Map<string, PinLockoutRecord>();
  return Object.freeze({
    get: async (orgId, storeId, staffId, deviceId) =>
      lockouts.get(lockoutKey(orgId, storeId, staffId, deviceId)) ?? null,
    upsert: async (record) => {
      lockouts.set(
        lockoutKey(record.org_id, record.store_id, record.staff_id, record.device_id),
        record,
      );
    },
    clear: async (orgId, storeId, staffId, deviceId) => {
      lockouts.delete(lockoutKey(orgId, storeId, staffId, deviceId));
    },
  });
}
