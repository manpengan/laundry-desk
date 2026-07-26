/**
 * Postgres identity repositories for laundry_app + SET LOCAL GUC.
 * Blind lookups use SECURITY DEFINER functions from migration 0004.
 */

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import { withOrgGuc, withStoreGuc } from "../db/tenant-guc-client.js";
import { createPinChallengeRepo, createPinLockoutRepo } from "./pg-pin-repo.js";
import { lockDeviceLifecycle } from "./pg-device-lifecycle-lock.js";
import {
  lookupFamilyTenant,
  lookupSessionTenant,
  lookupTokenTenant,
  storeScopeOf,
} from "./pg-identity-tenant.js";
import { writeLifecycleAudit } from "./pg-lifecycle-audit.js";
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
  SessionLifecycleIssue,
  SessionLifecycleRepository,
  SessionRepository,
  StaffRepository,
} from "./types.js";

export type PgIdentityStore = Readonly<{
  staff: StaffRepository;
  orgStore: OrgStoreRepository;
  sessions: SessionRepository;
  refresh: RefreshRepository;
  lifecycle: SessionLifecycleRepository;
  pinChallenges: PinChallengeRepository;
  pinLockouts: PinLockoutRepository;
  pool: PgPool;
}>;

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
    getActiveTokenForSession: async (sessionId) => {
      const tenant = await lookupSessionTenant(pool, sessionId);
      if (tenant === null) return null;
      return withStoreGuc(pool, storeScopeOf(tenant), async (client) => {
        const result = await client.query<TokenRow>(
          `SELECT id::text, family_id::text, session_id::text, token_hash, status,
                  replacement_token_id::text, expires_at
             FROM refresh_tokens
            WHERE org_id = $1::uuid
              AND store_id = $2::uuid
              AND session_id = $3::uuid
              AND status = 'active'
            ORDER BY id
            LIMIT 2`,
          [tenant.org_id, tenant.store_id, sessionId],
        );
        if (result.rows.length !== 1) return null;
        const row = result.rows[0];
        if (row === undefined) return null;
        const token = mapToken(row);
        return token?.status === "active" ? token : null;
      });
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

class LifecycleStaleError extends Error {}

async function hasCurrentStaffAuthority(
  client: PgPoolClient,
  input: Readonly<{
    session: SessionLifecycleIssue["session"];
    expected_role?: "admin" | "staff";
  }>,
): Promise<boolean> {
  const result = await client.query<{ permission_version: number; role: string }>(
    `SELECT staff.permission_version, staff_role.role
       FROM staffs AS staff
       JOIN staff_store_roles AS staff_role
         ON staff_role.org_id = staff.org_id
        AND staff_role.staff_id = staff.id
      WHERE staff.org_id = $1
        AND staff_role.store_id = $2
        AND staff.id = $3
        AND staff.is_active = true
        AND staff_role.is_active = true
        AND staff.permission_version = $4
        AND ($5::text IS NULL OR staff_role.role = $5)
      LIMIT 2
      FOR SHARE OF staff, staff_role`,
    [
      input.session.org_id,
      input.session.store_id,
      input.session.staff_id,
      input.session.permission_version,
      input.expected_role ?? null,
    ],
  );
  return result.rows.length === 1;
}

async function insertSessionIssue(
  client: PgPoolClient,
  input: SessionLifecycleIssue,
): Promise<void> {
  const { session, family, token } = input;
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
  await client.query(
    `INSERT INTO refresh_families (
       id, session_id, org_id, store_id, status, created_at, revoked_at
     ) VALUES ($1,$2,$3,$4,$5,$6,NULL)`,
    [
      family.family_id,
      family.session_id,
      session.org_id,
      session.store_id,
      family.status,
      epochToDate(session.created_at),
    ],
  );
  await client.query(
    `INSERT INTO refresh_tokens (
       id, family_id, session_id, org_id, store_id, token_hash, status,
       replacement_token_id, expires_at, created_at, rotated_at, revoked_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,NULL,NULL)`,
    [
      token.token_id,
      token.family_id,
      token.session_id,
      session.org_id,
      session.store_id,
      token.token_hash,
      token.status,
      epochToDate(token.expires_at),
      epochToDate(session.created_at),
    ],
  );
}

async function replaceLoginSessions(
  client: PgPoolClient,
  input: SessionLifecycleIssue,
): Promise<void> {
  await client.query(
    `WITH revoked_sessions AS (
       UPDATE sessions
          SET status = 'revoked',
              session_version = session_version + 1,
              revoked_at = $4
        WHERE org_id = $1
          AND store_id = $2
          AND device_id = $3
          AND status = 'active'
       RETURNING id
     ), revoked_families AS (
       UPDATE refresh_families
          SET status = 'revoked', revoked_at = $4
        WHERE status = 'active'
          AND session_id IN (SELECT id FROM revoked_sessions)
       RETURNING id
     )
     UPDATE refresh_tokens
        SET status = 'revoked', revoked_at = $4
      WHERE status = 'active'
        AND family_id IN (SELECT id FROM revoked_families)`,
    [
      input.session.org_id,
      input.session.store_id,
      input.session.device_id,
      epochToDate(input.session.created_at),
    ],
  );
}

async function replacePinSession(
  client: PgPoolClient,
  input: SessionLifecycleIssue,
): Promise<void> {
  const replacement = input.replacement;
  if (replacement?.kind !== "pin_switch") throw new LifecycleStaleError();
  const activeLockout = await client.query(
    `SELECT 1
       FROM pin_lockouts
      WHERE org_id = $1
        AND store_id = $2
        AND staff_id = $3
        AND device_id = $4
        AND locked_until > $5
      FOR UPDATE`,
    [
      input.session.org_id,
      input.session.store_id,
      input.session.staff_id,
      input.session.device_id,
      epochToDate(input.session.created_at),
    ],
  );
  if ((activeLockout.rowCount ?? 0) > 0) throw new LifecycleStaleError();
  const challenge = await client.query(
    `UPDATE pin_challenges
        SET status = 'consumed', consumed_at = $9
      WHERE id = $1
        AND org_id = $2
        AND store_id = $3
        AND device_id = $4
        AND session_id = $5
        AND session_version = $6
        AND target_staff_id = $7
        AND attempts = $8
        AND attempts < max_attempts
        AND purpose = 'quick_switch'
        AND status = 'open'
        AND expires_at > $9`,
    [
      replacement.challenge_id,
      input.session.org_id,
      input.session.store_id,
      input.session.device_id,
      replacement.predecessor.session_id,
      replacement.predecessor.session_version,
      input.session.staff_id,
      replacement.challenge_failed_attempts,
      epochToDate(input.session.created_at),
    ],
  );
  if ((challenge.rowCount ?? 0) !== 1) throw new LifecycleStaleError();

  const session = await client.query(
    `UPDATE sessions
        SET status = 'revoked', session_version = session_version + 1, revoked_at = $5
      WHERE id = $1
        AND org_id = $2
        AND store_id = $3
        AND session_version = $4
        AND status = 'active'`,
    [
      replacement.predecessor.session_id,
      input.session.org_id,
      input.session.store_id,
      replacement.predecessor.session_version,
      epochToDate(input.session.created_at),
    ],
  );
  if ((session.rowCount ?? 0) !== 1) throw new LifecycleStaleError();

  const family = await client.query(
    `UPDATE refresh_families
        SET status = 'revoked', revoked_at = $3
      WHERE id = $1 AND session_id = $2 AND status = 'active'`,
    [
      replacement.predecessor.family_id,
      replacement.predecessor.session_id,
      epochToDate(input.session.created_at),
    ],
  );
  if ((family.rowCount ?? 0) !== 1) throw new LifecycleStaleError();
  await client.query(
    `UPDATE refresh_tokens
        SET status = 'revoked', revoked_at = $2
      WHERE family_id = $1 AND status = 'active'`,
    [replacement.predecessor.family_id, epochToDate(input.session.created_at)],
  );
  await client.query(
    `DELETE FROM pin_lockouts
      WHERE org_id = $1
        AND store_id = $2
        AND staff_id = $3
        AND device_id = $4`,
    [input.session.org_id, input.session.store_id, input.session.staff_id, input.session.device_id],
  );
}

function createLifecycleRepo(pool: PgPool): SessionLifecycleRepository {
  return Object.freeze({
    commitIssue: async (input) => {
      try {
        return await withStoreGuc(
          pool,
          {
            orgId: input.session.org_id,
            storeId: input.session.store_id,
            staffId: input.session.staff_id,
          },
          async (client) => {
            await lockDeviceLifecycle(
              client,
              input.session.org_id,
              input.session.store_id,
              input.session.device_id,
            );
            if (!(await hasCurrentStaffAuthority(client, input))) return 0 as const;
            if (input.replacement?.kind === "login") {
              await replaceLoginSessions(client, input);
            } else if (input.replacement?.kind === "pin_switch") {
              await replacePinSession(client, input);
            }
            await insertSessionIssue(client, input);
            return 1 as const;
          },
        );
      } catch (error) {
        if (error instanceof LifecycleStaleError) return 0;
        throw error;
      }
    },
    commitRefreshUse: async (input) =>
      withStoreGuc(
        pool,
        {
          orgId: input.session.org_id,
          storeId: input.session.store_id,
          staffId: input.session.staff_id,
        },
        async (client) => {
          await lockDeviceLifecycle(
            client,
            input.session.org_id,
            input.session.store_id,
            input.session.device_id,
          );
          const current = await client.query<{
            status: string;
            token_hash: string;
            expires_at: Date;
            session_status: string;
            session_version: number;
            family_status: string;
          }>(
            `SELECT token.status,
                    token.token_hash,
                    token.expires_at,
                    session.status AS session_status,
                    session.session_version,
                    family.status AS family_status
               FROM refresh_tokens AS token
               JOIN sessions AS session
                 ON session.id = token.session_id
                AND session.org_id = token.org_id
                AND session.store_id = token.store_id
               JOIN refresh_families AS family
                 ON family.id = token.family_id
                AND family.session_id = token.session_id
                AND family.org_id = token.org_id
                AND family.store_id = token.store_id
              WHERE token.id = $1
                AND token.family_id = $2
                AND token.session_id = $3
                AND token.token_hash = $4
                AND session.org_id = $5
                AND session.store_id = $6
                AND session.staff_id = $7
                AND session.device_id = $8
              FOR UPDATE OF token, session, family`,
            [
              input.presented_token_id,
              input.family.family_id,
              input.session.session_id,
              input.presented_token_hash,
              input.session.org_id,
              input.session.store_id,
              input.session.staff_id,
              input.session.device_id,
            ],
          );
          const row = current.rows[0];
          if (
            current.rows.length !== 1 ||
            row === undefined ||
            row.session_status !== "active" ||
            row.session_version !== input.session.session_version ||
            row.family_status !== "active" ||
            row.expires_at.getTime() <= input.now * 1_000
          ) {
            return "rejected" as const;
          }
          if (row.status === "rotated") {
            const revokedSession = await client.query(
              `UPDATE sessions
                  SET status = 'revoked',
                      session_version = session_version + 1,
                      revoked_at = $4
                WHERE id = $1
                  AND session_version = $2
                  AND status = 'active'
                  AND org_id = $3`,
              [
                input.session.session_id,
                input.session.session_version,
                input.session.org_id,
                epochToDate(input.now),
              ],
            );
            if ((revokedSession.rowCount ?? 0) !== 1) return "rejected" as const;
            const revokedFamily = await client.query(
              `UPDATE refresh_families
                  SET status = 'revoked', revoked_at = $3
                WHERE id = $1
                  AND session_id = $2
                  AND status = 'active'`,
              [input.family.family_id, input.session.session_id, epochToDate(input.now)],
            );
            if ((revokedFamily.rowCount ?? 0) !== 1) throw new LifecycleStaleError();
            await client.query(
              `UPDATE refresh_tokens
                  SET status = 'revoked', revoked_at = $2
                WHERE family_id = $1
                  AND status = 'active'`,
              [input.family.family_id, epochToDate(input.now)],
            );
            await writeLifecycleAudit(client, {
              command: "identity.refresh.reuse_revoked",
              org_id: input.session.org_id,
              store_id: input.session.store_id,
              staff_id: input.session.staff_id,
              session_id: input.session.session_id,
              device_id: input.session.device_id,
              at: input.now,
            });
            return "reuse_revoked" as const;
          }
          if (
            row.status !== "active" ||
            !(await hasCurrentStaffAuthority(client, input)) ||
            input.replacement_token.family_id !== input.family.family_id ||
            input.replacement_token.session_id !== input.session.session_id
          ) {
            return "rejected" as const;
          }
          const rotated = await client.query(
            `UPDATE refresh_tokens
                SET status = 'rotated', replacement_token_id = $2, rotated_at = NOW()
              WHERE id = $1
                AND family_id = $3
                AND session_id = $4
                AND status = 'active'`,
            [
              input.presented_token_id,
              input.replacement_token.token_id,
              input.family.family_id,
              input.session.session_id,
            ],
          );
          if ((rotated.rowCount ?? 0) !== 1) return "rejected" as const;
          await client.query(
            `INSERT INTO refresh_tokens (
               id, family_id, session_id, org_id, store_id, token_hash, status,
               replacement_token_id, expires_at, created_at, rotated_at, revoked_at
             ) VALUES ($1,$2,$3,$4,$5,$6,'active',NULL,$7,NOW(),NULL,NULL)`,
            [
              input.replacement_token.token_id,
              input.replacement_token.family_id,
              input.replacement_token.session_id,
              input.session.org_id,
              input.session.store_id,
              input.replacement_token.token_hash,
              epochToDate(input.replacement_token.expires_at),
            ],
          );
          return "rotated" as const;
        },
      ).catch((error: unknown) => {
        if (error instanceof LifecycleStaleError) return "rejected" as const;
        throw error;
      }),
    revokeSessionFamily: async (input) =>
      withStoreGuc(
        pool,
        { orgId: input.org_id, storeId: input.store_id, staffId: input.staff_id },
        async (client) => {
          await lockDeviceLifecycle(client, input.org_id, input.store_id, input.device_id);
          const session = await client.query(
            `UPDATE sessions
                SET status = 'revoked', session_version = session_version + 1, revoked_at = $7
              WHERE id = $1
                AND org_id = $2
                AND store_id = $3
                AND staff_id = $4
                AND device_id = $5
                AND session_version = $6
                AND status = 'active'`,
            [
              input.session_id,
              input.org_id,
              input.store_id,
              input.staff_id,
              input.device_id,
              input.session_version,
              epochToDate(input.revoked_at),
            ],
          );
          if ((session.rowCount ?? 0) !== 1) return 0 as const;
          const family = await client.query(
            `UPDATE refresh_families
                SET status = 'revoked', revoked_at = $3
              WHERE id = $1 AND session_id = $2 AND status = 'active'`,
            [input.family_id, input.session_id, epochToDate(input.revoked_at)],
          );
          if ((family.rowCount ?? 0) !== 1) throw new LifecycleStaleError();
          await client.query(
            `UPDATE refresh_tokens
                SET status = 'revoked', revoked_at = $2
              WHERE family_id = $1 AND status = 'active'`,
            [input.family_id, epochToDate(input.revoked_at)],
          );
          await writeLifecycleAudit(client, {
            command: "identity.logout",
            org_id: input.org_id,
            store_id: input.store_id,
            staff_id: input.staff_id,
            session_id: input.session_id,
            device_id: input.device_id,
            at: input.revoked_at,
          });
          return 1 as const;
        },
      ).catch((error: unknown) => {
        if (error instanceof LifecycleStaleError) return 0 as const;
        throw error;
      }),
  });
}

export function createPgIdentityStore(pool: PgPool): PgIdentityStore {
  return Object.freeze({
    staff: createStaffRepo(pool),
    orgStore: createOrgStoreRepo(pool),
    sessions: createSessionRepo(pool),
    refresh: createRefreshRepo(pool),
    lifecycle: createLifecycleRepo(pool),
    pinChallenges: createPinChallengeRepo(pool),
    pinLockouts: createPinLockoutRepo(pool),
    pool,
  });
}
