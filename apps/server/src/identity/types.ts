/**
 * C6 identity domain records and repository ports.
 * Persistence is injected (memory for tests; PG adapter later) — no real SQL here.
 */

import type { SqlClient, TenantContext } from "../db/types.js";

export type Uuid = string;
export type EpochSeconds = number;
export type AuthenticationMethod = "password" | "pin" | "refresh";

export type StaffRecord = Readonly<{
  staff_id: Uuid;
  org_id: Uuid;
  username: string;
  password_hash: string;
  pin_hash: string | null;
  display_name: string;
  is_active: boolean;
  permission_version: number;
}>;

export type OrgStoreRecord = Readonly<{
  org_id: Uuid;
  org_code: string;
  store_id: Uuid;
  store_code: string;
}>;

export type SessionRecord = Readonly<{
  session_id: Uuid;
  session_version: number;
  org_id: Uuid;
  store_id: Uuid;
  staff_id: Uuid;
  device_id: Uuid;
  permission_version: number;
  authentication_method: AuthenticationMethod;
  status: "active" | "revoked";
  family_id: Uuid;
  created_at: EpochSeconds;
  revoked_at: EpochSeconds | null;
}>;

export type RefreshFamilyRecord = Readonly<{
  family_id: Uuid;
  session_id: Uuid;
  status: "active" | "revoked";
}>;

export type RefreshTokenRecord =
  | Readonly<{
      status: "active";
      token_id: Uuid;
      family_id: Uuid;
      session_id: Uuid;
      token_hash: string;
      expires_at: EpochSeconds;
    }>
  | Readonly<{
      status: "rotated";
      token_id: Uuid;
      family_id: Uuid;
      session_id: Uuid;
      token_hash: string;
      expires_at: EpochSeconds;
      replacement_token_id: Uuid;
    }>
  | Readonly<{
      status: "revoked";
      token_id: Uuid;
      family_id: Uuid;
      session_id: Uuid;
      token_hash: string;
      expires_at: EpochSeconds;
    }>
  | Readonly<{ status: "unknown" }>;

export type PinChallengePurpose = "quick_switch" | "step_up";

export type PinChallengeRecord = Readonly<{
  challenge_id: Uuid;
  purpose: PinChallengePurpose;
  session_id: Uuid;
  session_version: number;
  org_id: Uuid;
  store_id: Uuid;
  device_id: Uuid;
  nonce: Uuid;
  issued_at: EpochSeconds;
  expires_at: EpochSeconds;
  status: "active" | "consumed";
  failed_attempts: number;
  max_attempts: number;
  requester_staff_id: Uuid;
  target_staff_id?: Uuid;
  pending_action_ref?: string;
  args_hash?: string;
  entity_versions?: readonly Readonly<{
    entity_type: string;
    entity_id: Uuid;
    version: number;
  }>[];
  idempotency_key?: Uuid;
  approver_staff_id?: Uuid;
}>;

/** Staff/device lockout after PIN brute force (design: 15 minutes). */
export type PinLockoutRecord = Readonly<{
  org_id: Uuid;
  store_id: Uuid;
  staff_id: Uuid;
  device_id: Uuid;
  locked_until: EpochSeconds;
  failed_attempts: number;
  /** Backed by pin_lockouts.updated_at; starts a new window after 15 idle minutes. */
  last_failed_at: EpochSeconds;
}>;

export type PinFailureMutation = Readonly<{
  challenge_id: Uuid;
  org_id: Uuid;
  store_id: Uuid;
  staff_id: Uuid;
  device_id: Uuid;
  expected_failed_attempts: number;
  next_failed_attempts: number;
  attempted_at: EpochSeconds;
  locked_until: EpochSeconds;
}>;

export type PinSuccessMutation = Readonly<{
  challenge_id: Uuid;
  org_id: Uuid;
  store_id: Uuid;
  staff_id: Uuid;
  device_id: Uuid;
  expected_failed_attempts: number;
  attempted_at: EpochSeconds;
}>;

export type PinSuccessTransactionContext = Readonly<{
  client: SqlClient;
  tenant: TenantContext;
}>;

export type PinSuccessCommit = (transaction?: PinSuccessTransactionContext) => Promise<void>;

export type IdentityErrorCode =
  | "AUTHENTICATION_FAILED"
  | "CSRF_REJECTED"
  | "PIN_LOCKED"
  | "PIN_CHALLENGE_INVALID"
  | "SESSION_INVALID";

/**
 * Why an authentication attempt failed, for server-side evidence only.
 *
 * The response an unauthenticated caller receives is uniform on purpose — the
 * outside must not learn whether a request was well-formed. Operators looking
 * at their own logs need exactly the opposite, because a client that omits a
 * required field is otherwise indistinguishable from a wrong password.
 * Never map this onto a response body, status code, or header.
 */
export type IdentityFailureDetail = "malformed_request" | "credential_mismatch";

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;

  readonly detail?: IdentityFailureDetail;

  constructor(code: IdentityErrorCode, message: string, detail?: IdentityFailureDetail) {
    super(message);
    this.name = "IdentityError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** Lookup ports — memory or fake-sql adapters implement these. */
export type StaffRepository = Readonly<{
  findByOrgUsername: (orgId: Uuid, username: string) => Promise<StaffRecord | null>;
  findById: (orgId: Uuid, staffId: Uuid) => Promise<StaffRecord | null>;
}>;

export type OrgStoreRepository = Readonly<{
  findByCodes: (orgCode: string, storeCode: string) => Promise<OrgStoreRecord | null>;
}>;

export type SessionRepository = Readonly<{
  get: (sessionId: Uuid) => Promise<SessionRecord | null>;
  insert: (session: SessionRecord) => Promise<void>;
  revoke: (sessionId: Uuid, nextVersion: number, revokedAt: EpochSeconds) => Promise<boolean>;
}>;

export type RefreshRepository = Readonly<{
  getFamily: (familyId: Uuid) => Promise<RefreshFamilyRecord | null>;
  getTokenByHash: (tokenHash: string) => Promise<RefreshTokenRecord>;
  /** Resolve the sole current proof-rotation nonce for an active session. */
  getActiveTokenForSession: (
    sessionId: Uuid,
  ) => Promise<Extract<RefreshTokenRecord, { status: "active" }> | null>;
  insertFamily: (family: RefreshFamilyRecord) => Promise<void>;
  insertToken: (token: Exclude<RefreshTokenRecord, { status: "unknown" }>) => Promise<void>;
  /** CAS: mark active token rotated only if still active; returns matched row count. */
  rotateToken: (tokenId: Uuid, replacementTokenId: Uuid) => Promise<0 | 1>;
  revokeFamily: (familyId: Uuid) => Promise<boolean>;
}>;

export type SessionPredecessor = Readonly<{
  session_id: Uuid;
  session_version: number;
  family_id: Uuid;
}>;

export type SessionIssueReplacement =
  | Readonly<{ kind: "login" }>
  | Readonly<{
      kind: "pin_switch";
      predecessor: SessionPredecessor;
      challenge_id: Uuid;
      challenge_failed_attempts: number;
    }>;

export type SessionLifecycleIssue = Readonly<{
  session: SessionRecord;
  family: RefreshFamilyRecord;
  token: Extract<RefreshTokenRecord, { status: "active" }>;
  replacement?: SessionIssueReplacement;
  expected_role?: "admin" | "staff";
}>;

export type SessionLifecycleRefreshUse = Readonly<{
  session: SessionRecord;
  family: RefreshFamilyRecord;
  presented_token_id: Uuid;
  presented_token_hash: string;
  replacement_token: Extract<RefreshTokenRecord, { status: "active" }>;
  expected_role?: "admin" | "staff";
  now: EpochSeconds;
}>;

export type SessionLifecycleRefreshDisposition = "rotated" | "reuse_revoked" | "rejected";

export type SessionLifecycleRevocation = Readonly<{
  org_id: Uuid;
  store_id: Uuid;
  staff_id: Uuid;
  device_id: Uuid;
  session_id: Uuid;
  session_version: number;
  family_id: Uuid;
  revoked_at: EpochSeconds;
}>;

/**
 * Atomic storage boundary for session/family/token lifecycle mutations.
 * A zero result is a stale compare-and-set; no partial writes may remain.
 */
export type SessionLifecycleRepository = Readonly<{
  commitIssue: (input: SessionLifecycleIssue) => Promise<0 | 1>;
  commitRefreshUse: (
    input: SessionLifecycleRefreshUse,
  ) => Promise<SessionLifecycleRefreshDisposition>;
  revokeSessionFamily: (input: SessionLifecycleRevocation) => Promise<0 | 1>;
}>;

export type PinChallengeRepository = Readonly<{
  get: (challengeId: Uuid) => Promise<PinChallengeRecord | null>;
  insert: (challenge: PinChallengeRecord) => Promise<void>;
  /** CAS update of failed_attempts / status while still active. */
  casUpdate: (
    challengeId: Uuid,
    expectedFailed: number,
    next: Readonly<{ failed_attempts: number; status: "active" | "consumed" }>,
  ) => Promise<0 | 1>;
  /** Atomically increments challenge and staff/device window counters. */
  recordFailure: (input: PinFailureMutation) => Promise<0 | 1>;
  /** Atomically consumes a successful challenge and clears its staff/device lockout. */
  consumeSuccess: (input: PinSuccessMutation, commit?: PinSuccessCommit) => Promise<0 | 1>;
}>;

export type PinLockoutRepository = Readonly<{
  get: (
    orgId: Uuid,
    storeId: Uuid,
    staffId: Uuid,
    deviceId: Uuid,
  ) => Promise<PinLockoutRecord | null>;
  upsert: (record: PinLockoutRecord) => Promise<void>;
  clear: (orgId: Uuid, storeId: Uuid, staffId: Uuid, deviceId: Uuid) => Promise<void>;
}>;

export type IdentityClock = Readonly<{
  nowEpochSeconds: () => EpochSeconds;
}>;

export type IdGenerator = Readonly<{
  uuid: () => Uuid;
}>;

/** Refresh secret + cookie descriptor material (no real HTTP). */
export type RefreshCookieMaterial = Readonly<{
  /** Opaque secret for the httpOnly cookie value (never logged). */
  refresh_token: string;
  cookie: Readonly<{
    name: string;
    secure: true;
    http_only: true;
    same_site: "strict";
    path: "/";
    max_age_seconds: number;
  }>;
}>;

export type CsrfCookieMaterial = Readonly<{
  csrf_token: string;
  cookie: Readonly<{
    name: string;
    secure: true;
    http_only: false;
    same_site: "strict";
    path: "/";
  }>;
}>;

export type SessionIssueResult = Readonly<{
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  storage: "memory_only";
  session: Readonly<{
    session_id: Uuid;
    session_version: number;
    org_id: Uuid;
    store_id: Uuid;
    staff_id: Uuid;
    device_id: Uuid;
    permission_version: number;
  }>;
  refresh: RefreshCookieMaterial;
  csrf: CsrfCookieMaterial;
}>;
