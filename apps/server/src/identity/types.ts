/**
 * C6 identity domain records and repository ports.
 * Persistence is injected (memory for tests; PG adapter later) — no real SQL here.
 */

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
}>;

export type IdentityErrorCode =
  | "AUTHENTICATION_FAILED"
  | "CSRF_REJECTED"
  | "PIN_LOCKED"
  | "PIN_CHALLENGE_INVALID"
  | "SESSION_INVALID";

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;

  constructor(code: IdentityErrorCode, message: string) {
    super(message);
    this.name = "IdentityError";
    this.code = code;
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
  insertFamily: (family: RefreshFamilyRecord) => Promise<void>;
  insertToken: (token: Exclude<RefreshTokenRecord, { status: "unknown" }>) => Promise<void>;
  /** CAS: mark active token rotated only if still active; returns matched row count. */
  rotateToken: (tokenId: Uuid, replacementTokenId: Uuid) => Promise<0 | 1>;
  revokeFamily: (familyId: Uuid) => Promise<boolean>;
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
