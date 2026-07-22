/**
 * PIN challenge / lockout repos for PG identity (GUC writes + definer reads).
 */

import { randomUUID } from "node:crypto";

import type { PgPool } from "../db/pg-pool.js";
import { withStoreGuc } from "../db/tenant-guc-client.js";
import {
  dateToEpoch,
  epochToDate,
  mapPin,
  pinStatusToSql,
  type PinRow,
} from "./pg-store-mappers.js";
import type {
  PinChallengeRepository,
  PinLockoutRecord,
  PinLockoutRepository,
  Uuid,
} from "./types.js";

type LockoutRow = {
  org_id: string;
  store_id: string;
  staff_id: string;
  device_id: string;
  locked_until: Date | string;
  failed_attempts: number;
};

const mapLockout = (row: LockoutRow): PinLockoutRecord =>
  Object.freeze({
    org_id: row.org_id,
    store_id: row.store_id,
    staff_id: row.staff_id,
    device_id: row.device_id,
    locked_until: dateToEpoch(row.locked_until),
    failed_attempts: row.failed_attempts,
  });

export function createPinChallengeRepo(pool: PgPool): PinChallengeRepository {
  return Object.freeze({
    get: async (challengeId) => {
      const result = await pool.query<PinRow>(
        `SELECT id::text, org_id::text, store_id::text, device_id::text,
                session_id::text, session_version, purpose,
                target_staff_id::text, approver_staff_id::text,
                pending_action_ref, args_hash, entity_versions,
                idempotency_key::text, nonce, attempts, max_attempts,
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
          const entityVersionsJson = JSON.stringify(challenge.entity_versions ?? []);
          await client.query(
            `INSERT INTO pin_challenges (
               id, org_id, store_id, device_id, session_id, session_version,
               purpose, target_staff_id, approver_staff_id, pending_action_ref,
               args_hash, entity_versions, idempotency_key,
               nonce, attempts, max_attempts, status, issued_at, expires_at, consumed_at
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,
               $14,$15,$16,$17,$18,$19,$20
             )`,
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
              challenge.args_hash ?? null,
              entityVersionsJson,
              challenge.idempotency_key ?? null,
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

/**
 * Durable pin_lockouts under laundry_app + store GUC.
 * Natural key: (org_id, store_id, staff_id, device_id).
 */
export function createPinLockoutRepo(pool: PgPool): PinLockoutRepository {
  return Object.freeze({
    get: async (orgId, storeId, staffId, deviceId) =>
      withStoreGuc(pool, { orgId, storeId, staffId }, async (client) => {
        const result = await client.query<LockoutRow>(
          `SELECT org_id::text, store_id::text, staff_id::text, device_id::text,
                    locked_until, failed_attempts
             FROM pin_lockouts
             WHERE org_id = $1::uuid AND store_id = $2::uuid
               AND staff_id = $3::uuid AND device_id = $4::uuid
             LIMIT 1`,
          [orgId, storeId, staffId, deviceId],
        );
        const row = result.rows[0];
        return row === undefined ? null : mapLockout(row);
      }),
    upsert: async (record) => {
      await withStoreGuc(
        pool,
        {
          orgId: record.org_id,
          storeId: record.store_id,
          staffId: record.staff_id,
        },
        async (client) => {
          await client.query(
            `INSERT INTO pin_lockouts (
               id, org_id, store_id, staff_id, device_id,
               locked_until, failed_attempts, updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
             ON CONFLICT (org_id, store_id, staff_id, device_id) DO UPDATE
             SET locked_until = EXCLUDED.locked_until,
                 failed_attempts = EXCLUDED.failed_attempts,
                 updated_at = NOW()`,
            [
              randomUUID(),
              record.org_id,
              record.store_id,
              record.staff_id,
              record.device_id,
              epochToDate(record.locked_until),
              record.failed_attempts,
            ],
          );
        },
      );
    },
    clear: async (orgId, storeId, staffId, deviceId) => {
      await withStoreGuc(pool, { orgId, storeId, staffId }, async (client) => {
        await client.query(
          `DELETE FROM pin_lockouts
             WHERE org_id = $1::uuid AND store_id = $2::uuid
               AND staff_id = $3::uuid AND device_id = $4::uuid`,
          [orgId, storeId, staffId, deviceId],
        );
      });
    },
  });
}

/** Process-local lockouts for unit tests that do not open a pool. */
export function createMemoryPinLockoutRepo(): PinLockoutRepository {
  const lockouts = new Map<string, PinLockoutRecord>();
  const key = (orgId: Uuid, storeId: Uuid, staffId: Uuid, deviceId: Uuid): string =>
    `${orgId}|${storeId}|${staffId}|${deviceId}`;
  return Object.freeze({
    get: async (orgId, storeId, staffId, deviceId) =>
      lockouts.get(key(orgId, storeId, staffId, deviceId)) ?? null,
    upsert: async (record) => {
      lockouts.set(key(record.org_id, record.store_id, record.staff_id, record.device_id), record);
    },
    clear: async (orgId, storeId, staffId, deviceId) => {
      lockouts.delete(key(orgId, storeId, staffId, deviceId));
    },
  });
}
