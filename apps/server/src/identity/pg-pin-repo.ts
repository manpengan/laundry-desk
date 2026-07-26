/**
 * PIN challenge / lockout repos for PG identity (GUC writes + definer reads).
 */

import { randomUUID } from "node:crypto";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import { withStoreGuc } from "../db/tenant-guc-client.js";
import { lockDeviceLifecycle } from "./pg-device-lifecycle-lock.js";
import { writePinLockoutAudit } from "./pin-lockout-audit.js";
import { advancePinLockoutWindow } from "./pin-lockout-window.js";
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
  updated_at: Date | string;
};

type PinMutationScope = Readonly<{
  challenge_id: Uuid;
  org_id: Uuid;
  store_id: Uuid;
  staff_id: Uuid;
  device_id: Uuid;
}>;

const mapLockout = (row: LockoutRow): PinLockoutRecord =>
  Object.freeze({
    org_id: row.org_id,
    store_id: row.store_id,
    staff_id: row.staff_id,
    device_id: row.device_id,
    locked_until: dateToEpoch(row.locked_until),
    failed_attempts: row.failed_attempts,
    last_failed_at: dateToEpoch(row.updated_at),
  });

export const SELECT_PIN_LOCKOUT_FOR_UPDATE_SQL = Object.freeze(
  `SELECT org_id::text, store_id::text, staff_id::text, device_id::text,
          locked_until, failed_attempts, updated_at
     FROM pin_lockouts
    WHERE org_id = $1
      AND store_id = $2
      AND staff_id = $3
      AND device_id = $4
    FOR UPDATE`,
);

async function getLockoutForUpdate(
  client: PgPoolClient,
  input: Readonly<{
    org_id: Uuid;
    store_id: Uuid;
    staff_id: Uuid;
    device_id: Uuid;
  }>,
): Promise<PinLockoutRecord | null> {
  const result = await client.query<LockoutRow>(SELECT_PIN_LOCKOUT_FOR_UPDATE_SQL, [
    input.org_id,
    input.store_id,
    input.staff_id,
    input.device_id,
  ]);
  const row = result.rows[0];
  return row === undefined ? null : mapLockout(row);
}

export const LOOKUP_PIN_MUTATION_ACTOR_SQL = Object.freeze(
  `SELECT requester_staff_id::text
     FROM laundry_auth_lookup_pin($1::uuid)
    WHERE org_id = $2::uuid
      AND store_id = $3::uuid
      AND device_id = $4::uuid
      AND (
        (purpose = 'quick_switch' AND target_staff_id = $5::uuid)
        OR (purpose = 'step_up' AND approver_staff_id = $5::uuid)
      )
    LIMIT 1`,
);

async function lookupPinMutationActor(pool: PgPool, input: PinMutationScope): Promise<Uuid | null> {
  const result = await pool.query<{ requester_staff_id: string }>(LOOKUP_PIN_MUTATION_ACTOR_SQL, [
    input.challenge_id,
    input.org_id,
    input.store_id,
    input.device_id,
    input.staff_id,
  ]);
  return result.rows[0]?.requester_staff_id ?? null;
}

export const RECORD_PIN_FAILURE_SQL = Object.freeze(
  `UPDATE pin_challenges AS challenge
      SET attempts = $7,
          status = CASE
            WHEN $7 >= challenge.max_attempts THEN 'exhausted'
            ELSE 'open'
          END,
          consumed_at = CASE
            WHEN $7 >= challenge.max_attempts THEN NOW()
            ELSE challenge.consumed_at
          END
     FROM sessions AS requester_session
    WHERE challenge.id = $1
      AND challenge.org_id = $2
      AND challenge.store_id = $3
      AND challenge.device_id = $4
      AND requester_session.id = challenge.session_id
      AND requester_session.org_id = challenge.org_id
      AND requester_session.store_id = challenge.store_id
      AND requester_session.device_id = challenge.device_id
      AND requester_session.session_version = challenge.session_version
      AND requester_session.staff_id = $9::uuid
      AND (
        (challenge.purpose = 'quick_switch' AND challenge.target_staff_id = $5)
        OR (challenge.purpose = 'step_up' AND challenge.approver_staff_id = $5)
      )
      AND challenge.status = 'open'
      AND challenge.attempts = $6
      AND challenge.attempts < challenge.max_attempts
      AND $7 = $6 + 1
      AND challenge.expires_at > $8
    RETURNING challenge.max_attempts,
              requester_session.staff_id::text AS requester_staff_id`,
);

export const CONSUME_PIN_SUCCESS_SQL = Object.freeze(
  `UPDATE pin_challenges AS challenge
      SET status = 'consumed',
          consumed_at = NOW()
     FROM sessions AS requester_session
    WHERE challenge.id = $1
      AND challenge.org_id = $2
      AND challenge.store_id = $3
      AND challenge.device_id = $4
      AND requester_session.id = challenge.session_id
      AND requester_session.org_id = challenge.org_id
      AND requester_session.store_id = challenge.store_id
      AND requester_session.device_id = challenge.device_id
      AND requester_session.session_version = challenge.session_version
      AND requester_session.staff_id = $8::uuid
      AND (
        (challenge.purpose = 'quick_switch' AND challenge.target_staff_id = $5)
        OR (challenge.purpose = 'step_up' AND challenge.approver_staff_id = $5)
      )
      AND challenge.status = 'open'
      AND challenge.attempts = $6
      AND challenge.attempts < challenge.max_attempts
      AND challenge.expires_at > $7
    RETURNING requester_session.staff_id::text AS requester_staff_id`,
);

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
    recordFailure: async (input) => {
      const requesterStaffId = await lookupPinMutationActor(pool, input);
      if (requesterStaffId === null) return 0;
      return withStoreGuc(
        pool,
        {
          orgId: input.org_id,
          storeId: input.store_id,
          staffId: requesterStaffId,
        },
        async (client) => {
          await lockDeviceLifecycle(client, input.org_id, input.store_id, input.device_id);
          const currentLockout = await getLockoutForUpdate(client, input);
          if (currentLockout !== null && currentLockout.locked_until > input.attempted_at) {
            return 0 as const;
          }
          const result = await client.query<{
            max_attempts: number;
            requester_staff_id: string;
          }>(RECORD_PIN_FAILURE_SQL, [
            input.challenge_id,
            input.org_id,
            input.store_id,
            input.device_id,
            input.staff_id,
            input.expected_failed_attempts,
            input.next_failed_attempts,
            epochToDate(input.attempted_at),
            requesterStaffId,
          ]);
          const row = result.rows[0];
          if (result.rows.length !== 1 || row === undefined) return 0 as const;
          if (row.requester_staff_id !== requesterStaffId) {
            throw new Error("PIN requester binding changed");
          }
          const nextLockout = advancePinLockoutWindow(currentLockout, input, row.max_attempts);
          await client.query(
            `INSERT INTO pin_lockouts (
               id, org_id, store_id, staff_id, device_id,
               locked_until, failed_attempts, updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (org_id, store_id, staff_id, device_id) DO UPDATE
             SET locked_until = EXCLUDED.locked_until,
                 failed_attempts = EXCLUDED.failed_attempts,
                 updated_at = EXCLUDED.updated_at`,
            [
              randomUUID(),
              nextLockout.org_id,
              nextLockout.store_id,
              nextLockout.staff_id,
              nextLockout.device_id,
              epochToDate(nextLockout.locked_until),
              nextLockout.failed_attempts,
              epochToDate(nextLockout.last_failed_at),
            ],
          );
          if (nextLockout.failed_attempts >= row.max_attempts) {
            await writePinLockoutAudit(client, {
              org_id: nextLockout.org_id,
              store_id: nextLockout.store_id,
              actor_staff_id: row.requester_staff_id,
              target_staff_id: nextLockout.staff_id,
              device_id: nextLockout.device_id,
              attempted_at: nextLockout.last_failed_at,
            });
          }
          return 1 as const;
        },
      );
    },
    consumeSuccess: async (input) => {
      const requesterStaffId = await lookupPinMutationActor(pool, input);
      if (requesterStaffId === null) return 0;
      return withStoreGuc(
        pool,
        {
          orgId: input.org_id,
          storeId: input.store_id,
          staffId: requesterStaffId,
        },
        async (client) => {
          await lockDeviceLifecycle(client, input.org_id, input.store_id, input.device_id);
          const currentLockout = await getLockoutForUpdate(client, input);
          if (currentLockout !== null && currentLockout.locked_until > input.attempted_at) {
            return 0 as const;
          }
          const consumed = await client.query<{ requester_staff_id: string }>(
            CONSUME_PIN_SUCCESS_SQL,
            [
              input.challenge_id,
              input.org_id,
              input.store_id,
              input.device_id,
              input.staff_id,
              input.expected_failed_attempts,
              epochToDate(input.attempted_at),
              requesterStaffId,
            ],
          );
          if ((consumed.rowCount ?? 0) !== 1) return 0 as const;
          if (consumed.rows[0]?.requester_staff_id !== requesterStaffId) {
            throw new Error("PIN requester binding changed");
          }
          await client.query(
            `DELETE FROM pin_lockouts
              WHERE org_id = $1
                AND store_id = $2
                AND staff_id = $3
                AND device_id = $4`,
            [input.org_id, input.store_id, input.staff_id, input.device_id],
          );
          return 1 as const;
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
                    locked_until, failed_attempts, updated_at
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
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (org_id, store_id, staff_id, device_id) DO UPDATE
             SET locked_until = EXCLUDED.locked_until,
                 failed_attempts = EXCLUDED.failed_attempts,
                 updated_at = EXCLUDED.updated_at`,
            [
              randomUUID(),
              record.org_id,
              record.store_id,
              record.staff_id,
              record.device_id,
              epochToDate(record.locked_until),
              record.failed_attempts,
              epochToDate(record.last_failed_at),
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
