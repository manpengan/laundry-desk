/**
 * Postgres identity repositories for laundry_app + SET LOCAL GUC.
 * Blind lookups use SECURITY DEFINER functions from migration 0004.
 */

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import { withOrgGuc, withStoreGuc } from "../db/tenant-guc-client.js";
import { createPinChallengeRepo, createPinLockoutRepo } from "./pg-pin-repo.js";
import {
  epochToDate,
  mapSession,
  mapStaff,
  mapToken,
  type SessionRow,
  type StaffRow,
  type TokenRow,
} from "./pg-store-mappers.js";
import type {
  OrgStoreRecord,
  OrgStoreRepository,
  PinChallengeRepository,
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

type TenantIds = Readonly<{ org_id: Uuid; store_id: Uuid; staff_id: Uuid }>;

function storeScopeOf(tenant: TenantIds): Readonly<{
  orgId: Uuid;
  storeId: Uuid;
  staffId: Uuid;
}> {
  return Object.freeze({
    orgId: tenant.org_id,
    storeId: tenant.store_id,
    staffId: tenant.staff_id,
  });
}

async function lookupSessionTenant(pool: PgPool, sessionId: Uuid): Promise<TenantIds | null> {
  const result = await pool.query<{ org_id: string; store_id: string; staff_id: string }>(
    `SELECT org_id::text, store_id::text, staff_id::text
     FROM laundry_auth_lookup_session($1::uuid)`,
    [sessionId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return { org_id: row.org_id, store_id: row.store_id, staff_id: row.staff_id };
}

async function lookupFamilyTenant(pool: PgPool, familyId: Uuid): Promise<TenantIds | null> {
  const result = await pool.query<{ org_id: string; store_id: string }>(
    `SELECT org_id::text, store_id::text FROM laundry_auth_lookup_family($1::uuid)`,
    [familyId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    org_id: row.org_id,
    store_id: row.store_id,
    staff_id: "00000000-0000-4000-8000-000000000000",
  };
}

async function lookupTokenTenant(pool: PgPool, tokenId: Uuid): Promise<TenantIds | null> {
  const result = await pool.query<{ org_id: string; store_id: string }>(
    `SELECT org_id::text, store_id::text FROM laundry_auth_lookup_refresh_by_id($1::uuid)`,
    [tokenId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    org_id: row.org_id,
    store_id: row.store_id,
    staff_id: "00000000-0000-4000-8000-000000000000",
  };
}

function createStaffRepo(pool: PgPool): StaffRepository {
  return Object.freeze({
    findByOrgUsername: async (orgId, username) =>
      withOrgGuc(pool, { orgId }, async (client) => {
        const result = await client.query<StaffRow>(
          `SELECT id::text, org_id::text, username, password_hash, pin_hash,
                  display_name, is_active, permission_version
           FROM staffs WHERE org_id = $1 AND username = $2`,
          [orgId, username],
        );
        const row = result.rows[0];
        return row === undefined ? null : mapStaff(row);
      }),
    findById: async (orgId, staffId) =>
      withOrgGuc(pool, { orgId, staffId }, async (client) => {
        const result = await client.query<StaffRow>(
          `SELECT id::text, org_id::text, username, password_hash, pin_hash,
                  display_name, is_active, permission_version
           FROM staffs WHERE org_id = $1 AND id = $2`,
          [orgId, staffId],
        );
        const row = result.rows[0];
        return row === undefined ? null : mapStaff(row);
      }),
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
        `SELECT org_id::text, org_code, store_id::text, store_code
         FROM laundry_auth_find_org_store($1, $2)`,
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
        `SELECT id::text, org_id::text, store_id::text, staff_id::text,
                device_id::text, session_version, permission_version,
                authentication_method, status, created_at, revoked_at,
                family_id::text
         FROM laundry_auth_lookup_session($1::uuid)`,
        [sessionId],
      );
      const row = result.rows[0];
      if (row === undefined || row.family_id === null) return null;
      return mapSession(row);
    },
    insert: async (session) => {
      await withStoreGuc(
        pool,
        { orgId: session.org_id, storeId: session.store_id, staffId: session.staff_id },
        async (client) => {
          await client.query(
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
      );
    },
    revoke: async (sessionId, nextVersion, revokedAt) => {
      const tenant = await lookupSessionTenant(pool, sessionId);
      if (tenant === null) return false;
      return withStoreGuc(pool, storeScopeOf(tenant), async (client) => {
        const result = await client.query(
          `UPDATE sessions
           SET status = 'revoked', session_version = $2, revoked_at = $3
           WHERE id = $1 AND status = 'active'`,
          [sessionId, nextVersion, epochToDate(revokedAt)],
        );
        return (result.rowCount ?? 0) > 0;
      });
    },
  });
}

function createRefreshRepo(pool: PgPool): RefreshRepository {
  return Object.freeze({
    getFamily: async (familyId) => {
      const result = await pool.query<{ id: string; session_id: string; status: string }>(
        `SELECT id::text, session_id::text, status
         FROM laundry_auth_lookup_family($1::uuid)`,
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
         FROM laundry_auth_lookup_refresh_by_hash($1)`,
        [tokenHash],
      );
      const row = result.rows[0];
      if (row === undefined) return Object.freeze({ status: "unknown" as const });
      return mapToken(row) ?? Object.freeze({ status: "unknown" as const });
    },
    insertFamily: async (family) => {
      const tenant = await lookupSessionTenant(pool, family.session_id);
      if (tenant === null) {
        throw new Error(`insertFamily: session ${family.session_id} not found`);
      }
      await withStoreGuc(pool, storeScopeOf(tenant), async (client: PgPoolClient) => {
        await client.query(
          `INSERT INTO refresh_families (
             id, session_id, org_id, store_id, status, created_at, revoked_at
           ) VALUES ($1,$2,$3,$4,$5,NOW(),NULL)`,
          [family.family_id, family.session_id, tenant.org_id, tenant.store_id, family.status],
        );
      });
    },
    insertToken: async (token) => {
      const tenant = await lookupSessionTenant(pool, token.session_id);
      if (tenant === null) {
        throw new Error(`insertToken: session ${token.session_id} not found`);
      }
      const replacement = token.status === "rotated" ? token.replacement_token_id : null;
      await withStoreGuc(pool, storeScopeOf(tenant), async (client) => {
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
      const tenant = await lookupTokenTenant(pool, tokenId);
      if (tenant === null) return 0;
      return withStoreGuc(pool, storeScopeOf(tenant), async (client) => {
        const result = await client.query(
          `UPDATE refresh_tokens
           SET status = 'rotated', replacement_token_id = $2, rotated_at = NOW()
           WHERE id = $1 AND status = 'active'`,
          [tokenId, replacementTokenId],
        );
        return (result.rowCount ?? 0) > 0 ? 1 : 0;
      });
    },
    revokeFamily: async (familyId) => {
      const tenant = await lookupFamilyTenant(pool, familyId);
      if (tenant === null) return false;
      return withStoreGuc(pool, storeScopeOf(tenant), async (client) => {
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
