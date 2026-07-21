/**
 * In-memory identity repositories for unit tests (no Postgres).
 * Ports match types.ts so a future FakeSqlClient / PG adapter can replace this.
 */

import type {
  OrgStoreRecord,
  OrgStoreRepository,
  PinChallengeRecord,
  PinChallengeRepository,
  PinLockoutRecord,
  PinLockoutRepository,
  RefreshFamilyRecord,
  RefreshRepository,
  RefreshTokenRecord,
  SessionRecord,
  SessionRepository,
  StaffRecord,
  StaffRepository,
  Uuid,
} from "./types.js";

export type MemoryIdentityStore = Readonly<{
  staff: StaffRepository;
  orgStore: OrgStoreRepository;
  sessions: SessionRepository;
  refresh: RefreshRepository;
  pinChallenges: PinChallengeRepository;
  pinLockouts: PinLockoutRepository;
  /** Seed helpers for tests / fixtures. */
  seedStaff: (staff: StaffRecord) => void;
  seedOrgStore: (record: OrgStoreRecord) => void;
  /** Debug / assertion helpers. */
  listSessions: () => readonly SessionRecord[];
  listFamilies: () => readonly RefreshFamilyRecord[];
  listTokens: () => readonly Exclude<RefreshTokenRecord, { status: "unknown" }>[];
  listChallenges: () => readonly PinChallengeRecord[];
}>;

const lockoutKey = (orgId: Uuid, storeId: Uuid, staffId: Uuid, deviceId: Uuid): string =>
  `${orgId}|${storeId}|${staffId}|${deviceId}`;

export const createMemoryIdentityStore = (): MemoryIdentityStore => {
  const staffByKey = new Map<string, StaffRecord>();
  const staffById = new Map<string, StaffRecord>();
  const orgStores: OrgStoreRecord[] = [];
  const sessions = new Map<string, SessionRecord>();
  const families = new Map<string, RefreshFamilyRecord>();
  const tokensById = new Map<string, Exclude<RefreshTokenRecord, { status: "unknown" }>>();
  const tokenHashIndex = new Map<string, string>();
  const challenges = new Map<string, PinChallengeRecord>();
  const lockouts = new Map<string, PinLockoutRecord>();

  const staff: StaffRepository = Object.freeze({
    findByOrgUsername: async (orgId, username) => staffByKey.get(`${orgId}|${username}`) ?? null,
    findById: async (orgId, staffId) => {
      const row = staffById.get(staffId);
      if (row === undefined || row.org_id !== orgId) return null;
      return row;
    },
  });

  const orgStore: OrgStoreRepository = Object.freeze({
    findByCodes: async (orgCode, storeCode) =>
      orgStores.find((row) => row.org_code === orgCode && row.store_code === storeCode) ?? null,
  });

  const sessionRepo: SessionRepository = Object.freeze({
    get: async (sessionId) => sessions.get(sessionId) ?? null,
    insert: async (session) => {
      sessions.set(session.session_id, session);
    },
    revoke: async (sessionId, nextVersion, revokedAt) => {
      const current = sessions.get(sessionId);
      if (current === undefined || current.status !== "active") return false;
      sessions.set(sessionId, {
        ...current,
        status: "revoked",
        session_version: nextVersion,
        revoked_at: revokedAt,
      });
      return true;
    },
  });

  const refresh: RefreshRepository = Object.freeze({
    getFamily: async (familyId) => families.get(familyId) ?? null,
    getTokenByHash: async (tokenHash) => {
      const tokenId = tokenHashIndex.get(tokenHash);
      if (tokenId === undefined) return Object.freeze({ status: "unknown" as const });
      return tokensById.get(tokenId) ?? Object.freeze({ status: "unknown" as const });
    },
    insertFamily: async (family) => {
      families.set(family.family_id, family);
    },
    insertToken: async (token) => {
      tokensById.set(token.token_id, token);
      tokenHashIndex.set(token.token_hash, token.token_id);
    },
    rotateToken: async (tokenId, replacementTokenId) => {
      const current = tokensById.get(tokenId);
      if (current === undefined || current.status !== "active") return 0;
      tokensById.set(tokenId, {
        status: "rotated",
        token_id: current.token_id,
        family_id: current.family_id,
        session_id: current.session_id,
        token_hash: current.token_hash,
        expires_at: current.expires_at,
        replacement_token_id: replacementTokenId,
      });
      return 1;
    },
    revokeFamily: async (familyId) => {
      const family = families.get(familyId);
      if (family === undefined || family.status !== "active") return false;
      families.set(familyId, { ...family, status: "revoked" });
      for (const [id, token] of tokensById) {
        if (token.family_id === familyId && token.status === "active") {
          tokensById.set(id, {
            status: "revoked",
            token_id: token.token_id,
            family_id: token.family_id,
            session_id: token.session_id,
            token_hash: token.token_hash,
            expires_at: token.expires_at,
          });
        }
      }
      return true;
    },
  });

  const pinChallenges: PinChallengeRepository = Object.freeze({
    get: async (challengeId) => challenges.get(challengeId) ?? null,
    insert: async (challenge) => {
      challenges.set(challenge.challenge_id, challenge);
    },
    casUpdate: async (challengeId, expectedFailed, next) => {
      const current = challenges.get(challengeId);
      if (
        current === undefined ||
        current.status !== "active" ||
        current.failed_attempts !== expectedFailed
      ) {
        return 0;
      }
      challenges.set(challengeId, {
        ...current,
        failed_attempts: next.failed_attempts,
        status: next.status,
      });
      return 1;
    },
  });

  const pinLockouts: PinLockoutRepository = Object.freeze({
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

  return Object.freeze({
    staff,
    orgStore,
    sessions: sessionRepo,
    refresh,
    pinChallenges,
    pinLockouts,
    seedStaff: (row: StaffRecord) => {
      staffByKey.set(`${row.org_id}|${row.username}`, row);
      staffById.set(row.staff_id, row);
    },
    seedOrgStore: (row: OrgStoreRecord) => {
      orgStores.push(row);
    },
    listSessions: () => Object.freeze([...sessions.values()]),
    listFamilies: () => Object.freeze([...families.values()]),
    listTokens: () => Object.freeze([...tokensById.values()]),
    listChallenges: () => Object.freeze([...challenges.values()]),
  });
};
