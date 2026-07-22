/**
 * Postgres identity repositories implementing the same ports as memory-store.
 * Maps domain records ↔ packages/db M1 tables (0002_m1_identity_platform.sql).
 *
 * Pin lockouts have no table yet → process-local map (same process lifetime as server).
 * Schema gaps: sessions.family_id via refresh_families join; pin status open↔active.
 */

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import { withClient, withTransaction } from "../db/pg-pool.js";
import {
  epochToDate,
  mapPin,
  mapSession,
  mapStaff,
  mapToken,
  pinStatusToSql,
  type PinRow,
  type SessionRow,
  type StaffRow,
  type TokenRow,
} from "./pg-store-mappers.js";
import type {
  OrgStoreRecord,
  OrgStoreRepository,
  PinChallengeRepository,
  PinLockoutRecord,
  PinLockoutRepository,
  RefreshFamilyRecord,
  RefreshRepository,
  SessionRepository,
  StaffRepository,
  Uuid,
} from "./types.js";

export type PgIdentityStore = Readonly<{
  staff: StaffRepository;
  orgStore: OrgStoreRepository;
  sessions: SessionRepository;
  refresh: RefreshRepository;
  pinChallenges: PinChallengeRepository;
  pinLockouts: PinLockoutRepository;
  pool: PgPool;
}>;

const lockoutKey = (orgId: Uuid, storeId: Uuid, staffId: Uuid, deviceId: Uuid): string =>
  `${orgId}|${storeId}|${staffId}|${deviceId}`;

async function sessionTenant(
  client: PgPoolClient,
  sessionId: Uuid,
): Promise<{ org_id: Uuid; store_id: Uuid } | null> {
  const result = await client.query<{ org_id: string; store_id: string }>(
    `SELECT org_id::text, store_id::text FROM sessions WHERE id = $1`,
    [sessionId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return { org_id: row.org_id, store_id: row.store_id };
}

function createStaffRepo(pool: PgPool): StaffRepository {
  return Object.freeze({
    findByOrgUsername: async (orgId, username) => {
      const result = await pool.query<StaffRow>(
        `SELECT id::text, org_id::text, username, password_hash, pin_hash,
                display_name, is_active, permission_version
         FROM staffs WHERE org_id = $1 AND username = $2`,
        [orgId, username],
      );
      const row = result.rows[0];
      return row === undefined ? null : mapStaff(row);
    },
    findById: async (orgId, staffId) => {
      const result = await pool.query<StaffRow>(
        `SELECT id::text, org_id::text, username, password_hash, pin_hash,
                display_name, is_active, permission_version
         FROM staffs WHERE org_id = $1 AND id = $2`,
        [orgId, staffId],
      );
      const row = result.rows[0];
      return row === undefined ? null : mapStaff(row);
    },
  });
}

function createOrgStoreRepo(pool: PgPool): OrgStoreRepository {
  return Object.freeze({
    findByCodes: async (orgCode, storeCode) => {
      const result = await pool.query<{
        org_id: string;
        org_code: string;
        store_id: string;
        store_code: string;
      }>(
        `SELECT o.id::text AS org_id, o.code AS org_code,
                s.id::text AS store_id, s.code AS store_code
         FROM orgs o
         INNER JOIN stores s ON s.org_id = o.id
         WHERE o.code = $1 AND s.code = $2`,
        [orgCode, storeCode],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const record: OrgStoreRecord = Object.freeze({
        org_id: row.org_id,
        org_code: row.org_code,
        store_id: row.store_id,
        store_code: row.store_code,
      });
      return record;
    },
  });
}

function createSessionRepo(pool: PgPool): SessionRepository {
  return Object.freeze({
    get: async (sessionId) => {
      const result = await pool.query<SessionRow>(
        `SELECT s.id::text, s.org_id::text, s.store_id::text, s.staff_id::text,
                s.device_id::text, s.session_version, s.permission_version,
                s.authentication_method, s.status, s.created_at, s.revoked_at,
                f.id::text AS family_id
         FROM sessions s
         LEFT JOIN refresh_families f ON f.session_id = s.id AND f.status = 'active'
         WHERE s.id = $1
         ORDER BY f.created_at DESC NULLS LAST
         LIMIT 1`,
        [sessionId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      if (row.family_id === null) {
        const anyFamily = await pool.query<{ id: string }>(
          `SELECT id::text FROM refresh_families WHERE session_id = $1
           ORDER BY created_at DESC LIMIT 1`,
          [sessionId],
        );
        const fam = anyFamily.rows[0];
        if (fam === undefined) return null;
        return mapSession({ ...row, family_id: fam.id });
      }
      return mapSession(row);
    },
    insert: async (session) => {
      await pool.query(
        `INSERT INTO sessions (
           id, org_id, store_id, staff_id, device_id, session_version,
           permission_version, authentication_method, status, created_at, revoked_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          session.session_id,
          session.org_id,
          session.store_id,
          session.staff_id,
          session.device_id,
          session.session_version,
          session.permission_version,
          session.authentication_method,
          session.status,
          epochToDate(session.created_at),
          session.revoked_at === null ? null : epochToDate(session.revoked_at),
        ],
      );
    },
    revoke: async (sessionId, nextVersion, revokedAt) => {
      const result = await pool.query(
        `UPDATE sessions
         SET status = 'revoked', session_version = $2, revoked_at = $3
         WHERE id = $1 AND status = 'active'`,
        [sessionId, nextVersion, epochToDate(revokedAt)],
      );
      return (result.rowCount ?? 0) > 0;
    },
  });
}

function createRefreshRepo(pool: PgPool): RefreshRepository {
  return Object.freeze({
    getFamily: async (familyId) => {
      const result = await pool.query<{
        id: string;
        session_id: string;
        status: string;
      }>(
        `SELECT id::text, session_id::text, status FROM refresh_families WHERE id = $1`,
        [familyId],
      );
      const row = result.rows[0];
      if (row === undefined || (row.status !== "active" && row.status !== "revoked")) {
        return null;
      }
      const family: RefreshFamilyRecord = Object.freeze({
        family_id: row.id,
        session_id: row.session_id,
        status: row.status,
      });
      return family;
    },
    getTokenByHash: async (tokenHash) => {
      const result = await pool.query<TokenRow>(
        `SELECT id::text, family_id::text, session_id::text, token_hash, status,
                replacement_token_id::text, expires_at
         FROM refresh_tokens WHERE token_hash = $1`,
        [tokenHash],
      );
      const row = result.rows[0];
      if (row === undefined) return Object.freeze({ status: "unknown" as const });
      return mapToken(row) ?? Object.freeze({ status: "unknown" as const });
    },
    insertFamily: async (family) => {
      await withClient(pool, async (client) => {
        const tenant = await sessionTenant(client, family.session_id);
        if (tenant === null) {
          throw new Error(`insertFamily: session ${family.session_id} not found`);
        }
        await client.query(
          `INSERT INTO refresh_families (
             id, session_id, org_id, store_id, status, created_at, revoked_at
           ) VALUES ($1,$2,$3,$4,$5,NOW(),NULL)`,
          [family.family_id, family.session_id, tenant.org_id, tenant.store_id, family.status],
        );
      });
    },
    insertToken: async (token) => {
      await withClient(pool, async (client) => {
        const tenant = await sessionTenant(client, token.session_id);
        if (tenant === null) {
          throw new Error(`insertToken: session ${token.session_id} not found`);
        }
        const replacement = token.status === "rotated" ? token.replacement_token_id : null;
        await client.query(
          `INSERT INTO refresh_tokens (
             id, family_id, session_id, org_id, store_id, token_hash, status,
             replacement_token_id, expires_at, created_at, rotated_at, revoked_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NULL,NULL)`,
          [
            token.token_id,
            token.family_id,
            token.session_id,
            tenant.org_id,
            tenant.store_id,
            token.token_hash,
            token.status,
            replacement,
            epochToDate(token.expires_at),
          ],
        );
      });
    },
    rotateToken: async (tokenId, replacementTokenId) => {
      const result = await pool.query(
        `UPDATE refresh_tokens
         SET status = 'rotated', replacement_token_id = $2, rotated_at = NOW()
         WHERE id = $1 AND status = 'active'`,
        [tokenId, replacementTokenId],
      );
      return (result.rowCount ?? 0) > 0 ? 1 : 0;
    },
    revokeFamily: async (familyId) => {
      return withTransaction(pool, async (client) => {
        const fam = await client.query(
          `UPDATE refresh_families SET status = 'revoked', revoked_at = NOW()
           WHERE id = $1 AND status = 'active'`,
          [familyId],
        );
        if ((fam.rowCount ?? 0) === 0) return false;
        await client.query(
          `UPDATE refresh_tokens SET status = 'revoked', revoked_at = NOW()
           WHERE family_id = $1 AND status = 'active'`,
          [familyId],
        );
        return true;
      });
    },
  });
}

function createPinChallengeRepo(pool: PgPool): PinChallengeRepository {
  return Object.freeze({
    get: async (challengeId) => {
      const result = await pool.query<PinRow>(
        `SELECT p.id::text, p.org_id::text, p.store_id::text, p.device_id::text,
                p.session_id::text, p.session_version, p.purpose,
                p.target_staff_id::text, p.approver_staff_id::text,
                p.pending_action_ref, p.nonce, p.attempts, p.max_attempts,
                p.status, p.issued_at, p.expires_at,
                s.staff_id::text AS requester_staff_id
         FROM pin_challenges p
         INNER JOIN sessions s ON s.id = p.session_id
         WHERE p.id = $1`,
        [challengeId],
      );
      const row = result.rows[0];
      return row === undefined ? null : mapPin(row);
    },
    insert: async (challenge) => {
      await pool.query(
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
    casUpdate: async (challengeId, expectedFailed, next) => {
      const sqlStatus =
        next.status === "consumed" && next.failed_attempts >= 5
          ? "exhausted"
          : pinStatusToSql(next.status);
      const result = await pool.query(
        `UPDATE pin_challenges
         SET attempts = $3, status = $4,
             consumed_at = CASE WHEN $4 IN ('consumed','exhausted') THEN NOW() ELSE consumed_at END
         WHERE id = $1 AND status = 'open' AND attempts = $2`,
        [challengeId, expectedFailed, next.failed_attempts, sqlStatus],
      );
      return (result.rowCount ?? 0) > 0 ? 1 : 0;
    },
  });
}

function createPinLockoutRepo(): PinLockoutRepository {
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

export function createPgIdentityStore(pool: PgPool): PgIdentityStore {
  return Object.freeze({
    staff: createStaffRepo(pool),
    orgStore: createOrgStoreRepo(pool),
    sessions: createSessionRepo(pool),
    refresh: createRefreshRepo(pool),
    pinChallenges: createPinChallengeRepo(pool),
    pinLockouts: createPinLockoutRepo(),
    pool,
  });
}
