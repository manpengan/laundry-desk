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
  SessionLifecycleRepository,
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
  lifecycle: SessionLifecycleRepository;
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

  const revokeActiveFamily = (familyId: Uuid): void => {
    const family = families.get(familyId);
    if (family === undefined || family.status !== "active") return;
    families.set(familyId, Object.freeze({ ...family, status: "revoked" }));
    for (const [id, token] of tokensById) {
      if (token.family_id === familyId && token.status === "active") {
        tokensById.set(
          id,
          Object.freeze({
            status: "revoked" as const,
            token_id: token.token_id,
            family_id: token.family_id,
            session_id: token.session_id,
            token_hash: token.token_hash,
            expires_at: token.expires_at,
          }),
        );
      }
    }
  };

  const hasCurrentStaffAuthority = (session: SessionRecord): boolean => {
    const staff = staffById.get(session.staff_id);
    return (
      staff !== undefined &&
      staff.org_id === session.org_id &&
      staff.is_active &&
      staff.permission_version === session.permission_version
    );
  };

  const lifecycle: SessionLifecycleRepository = Object.freeze({
    commitIssue: async (input) => {
      if (
        !hasCurrentStaffAuthority(input.session) ||
        sessions.has(input.session.session_id) ||
        families.has(input.family.family_id) ||
        tokensById.has(input.token.token_id) ||
        tokenHashIndex.has(input.token.token_hash) ||
        input.family.session_id !== input.session.session_id ||
        input.token.session_id !== input.session.session_id ||
        input.token.family_id !== input.family.family_id
      ) {
        return 0;
      }

      const replacement = input.replacement;
      if (replacement?.kind === "pin_switch") {
        const previous = sessions.get(replacement.predecessor.session_id);
        const family = families.get(replacement.predecessor.family_id);
        const challenge = challenges.get(replacement.challenge_id);
        if (
          previous === undefined ||
          previous.status !== "active" ||
          previous.session_version !== replacement.predecessor.session_version ||
          family === undefined ||
          family.status !== "active" ||
          family.session_id !== previous.session_id ||
          challenge === undefined ||
          challenge.status !== "active" ||
          challenge.purpose !== "quick_switch" ||
          challenge.session_id !== previous.session_id ||
          challenge.session_version !== previous.session_version ||
          challenge.failed_attempts !== replacement.challenge_failed_attempts ||
          challenge.failed_attempts >= challenge.max_attempts ||
          challenge.expires_at <= input.session.created_at ||
          challenge.org_id !== input.session.org_id ||
          challenge.store_id !== input.session.store_id ||
          challenge.device_id !== input.session.device_id ||
          challenge.target_staff_id !== input.session.staff_id ||
          (lockouts.get(
            lockoutKey(
              input.session.org_id,
              input.session.store_id,
              input.session.staff_id,
              input.session.device_id,
            ),
          )?.locked_until ?? 0) > input.session.created_at
        ) {
          return 0;
        }
      }

      if (replacement?.kind === "login") {
        for (const [id, current] of sessions) {
          if (
            current.status === "active" &&
            current.org_id === input.session.org_id &&
            current.store_id === input.session.store_id &&
            current.device_id === input.session.device_id
          ) {
            sessions.set(
              id,
              Object.freeze({
                ...current,
                status: "revoked" as const,
                session_version: current.session_version + 1,
                revoked_at: input.session.created_at,
              }),
            );
            for (const family of families.values()) {
              if (family.session_id === id) revokeActiveFamily(family.family_id);
            }
          }
        }
      } else if (replacement?.kind === "pin_switch") {
        const previous = sessions.get(replacement.predecessor.session_id)!;
        sessions.set(
          previous.session_id,
          Object.freeze({
            ...previous,
            status: "revoked" as const,
            session_version: previous.session_version + 1,
            revoked_at: input.session.created_at,
          }),
        );
        revokeActiveFamily(replacement.predecessor.family_id);
        const challenge = challenges.get(replacement.challenge_id)!;
        challenges.set(
          challenge.challenge_id,
          Object.freeze({ ...challenge, status: "consumed" as const }),
        );
        lockouts.delete(
          lockoutKey(
            input.session.org_id,
            input.session.store_id,
            input.session.staff_id,
            input.session.device_id,
          ),
        );
      }

      sessions.set(input.session.session_id, input.session);
      families.set(input.family.family_id, input.family);
      tokensById.set(input.token.token_id, input.token);
      tokenHashIndex.set(input.token.token_hash, input.token.token_id);
      return 1;
    },
    commitRefreshUse: async (input) => {
      const session = sessions.get(input.session.session_id);
      const family = families.get(input.family.family_id);
      const token = tokensById.get(input.presented_token_id);
      if (
        session === undefined ||
        session.status !== "active" ||
        session.session_version !== input.session.session_version ||
        family === undefined ||
        family.status !== "active" ||
        family.session_id !== session.session_id ||
        token === undefined ||
        token.session_id !== session.session_id ||
        token.family_id !== family.family_id ||
        token.token_hash !== input.presented_token_hash ||
        token.expires_at <= input.now
      ) {
        return "rejected";
      }
      if (token.status === "rotated") {
        sessions.set(
          session.session_id,
          Object.freeze({
            ...session,
            status: "revoked" as const,
            session_version: session.session_version + 1,
            revoked_at: input.now,
          }),
        );
        revokeActiveFamily(family.family_id);
        return "reuse_revoked";
      }
      if (
        token.status !== "active" ||
        !hasCurrentStaffAuthority(input.session) ||
        tokensById.has(input.replacement_token.token_id) ||
        tokenHashIndex.has(input.replacement_token.token_hash) ||
        input.replacement_token.session_id !== session.session_id ||
        input.replacement_token.family_id !== family.family_id
      ) {
        return "rejected";
      }
      tokensById.set(
        token.token_id,
        Object.freeze({
          ...token,
          status: "rotated" as const,
          replacement_token_id: input.replacement_token.token_id,
        }),
      );
      tokensById.set(input.replacement_token.token_id, input.replacement_token);
      tokenHashIndex.set(input.replacement_token.token_hash, input.replacement_token.token_id);
      return "rotated";
    },
    revokeSessionFamily: async (input) => {
      const session = sessions.get(input.session_id);
      const family = families.get(input.family_id);
      if (
        session === undefined ||
        session.status !== "active" ||
        session.session_version !== input.session_version ||
        session.org_id !== input.org_id ||
        session.store_id !== input.store_id ||
        session.staff_id !== input.staff_id ||
        session.device_id !== input.device_id ||
        family === undefined ||
        family.status !== "active" ||
        family.session_id !== session.session_id
      ) {
        return 0;
      }
      sessions.set(
        session.session_id,
        Object.freeze({
          ...session,
          status: "revoked" as const,
          session_version: session.session_version + 1,
          revoked_at: input.revoked_at,
        }),
      );
      revokeActiveFamily(family.family_id);
      return 1;
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
    recordFailure: async (input) => {
      const current = challenges.get(input.challenge_id);
      if (
        current === undefined ||
        current.status !== "active" ||
        current.org_id !== input.org_id ||
        current.store_id !== input.store_id ||
        current.device_id !== input.device_id ||
        current.failed_attempts !== input.expected_failed_attempts ||
        input.next_failed_attempts !== input.expected_failed_attempts + 1 ||
        current.failed_attempts >= current.max_attempts ||
        current.expires_at <= input.attempted_at ||
        (lockouts.get(lockoutKey(input.org_id, input.store_id, input.staff_id, input.device_id))
          ?.locked_until ?? 0) > input.attempted_at ||
        (current.target_staff_id !== input.staff_id && current.approver_staff_id !== input.staff_id)
      ) {
        return 0;
      }
      const exhausted = input.next_failed_attempts >= current.max_attempts;
      challenges.set(
        current.challenge_id,
        Object.freeze({
          ...current,
          failed_attempts: input.next_failed_attempts,
          status: exhausted ? ("consumed" as const) : ("active" as const),
        }),
      );
      if (exhausted) {
        lockouts.set(
          lockoutKey(input.org_id, input.store_id, input.staff_id, input.device_id),
          Object.freeze({
            org_id: input.org_id,
            store_id: input.store_id,
            staff_id: input.staff_id,
            device_id: input.device_id,
            locked_until: input.locked_until,
            failed_attempts: input.next_failed_attempts,
          }),
        );
      }
      return 1;
    },
    consumeSuccess: async (input) => {
      const current = challenges.get(input.challenge_id);
      if (
        current === undefined ||
        current.status !== "active" ||
        current.org_id !== input.org_id ||
        current.store_id !== input.store_id ||
        current.device_id !== input.device_id ||
        current.failed_attempts !== input.expected_failed_attempts ||
        current.failed_attempts >= current.max_attempts ||
        current.expires_at <= input.attempted_at ||
        (lockouts.get(lockoutKey(input.org_id, input.store_id, input.staff_id, input.device_id))
          ?.locked_until ?? 0) > input.attempted_at ||
        (current.target_staff_id !== input.staff_id && current.approver_staff_id !== input.staff_id)
      ) {
        return 0;
      }
      challenges.set(
        current.challenge_id,
        Object.freeze({ ...current, status: "consumed" as const }),
      );
      lockouts.delete(lockoutKey(input.org_id, input.store_id, input.staff_id, input.device_id));
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
    lifecycle,
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
