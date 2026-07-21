/**
 * C6 identity public surface (ports + pure services).
 * Bus handlers / Fastify plugins are intentionally not wired yet.
 */

export { createScryptPasswordPort, createTestPasswordPort } from "./password.js";
export type { PasswordPort, PinPort } from "./password.js";

export {
  createAccessTokenSigner,
  createSessionService,
  issueSession,
  logoutSession,
  rotateRefresh,
} from "./session.js";
export type {
  IssueSessionInput,
  LogoutResult,
  RefreshResult,
  SessionServiceDeps,
} from "./session.js";

export {
  PIN_LOCKOUT_SECONDS,
  createPinService,
  createQuickSwitchChallenge,
  verifyQuickSwitchPin,
} from "./pin.js";
export type {
  CreatePinChallengeInput,
  PinChallengeView,
  PinServiceDeps,
  VerifyPinInput,
} from "./pin.js";

export { createLoginService, loginWithPassword } from "./login.js";
export type { LoginResult, LoginServiceDeps } from "./login.js";

export { createMemoryIdentityStore } from "./memory-store.js";
export type { MemoryIdentityStore } from "./memory-store.js";

export {
  buildAccessClaims,
  constantTimeEqual,
  hashOpaqueSecret,
  mintCsrfProof,
  newUuid,
  randomToken,
  sha256Hex,
} from "./crypto-util.js";
export type { AccessTokenSigner } from "./crypto-util.js";

export { IdentityError } from "./types.js";
export type {
  AuthenticationMethod,
  CsrfCookieMaterial,
  EpochSeconds,
  IdGenerator,
  IdentityClock,
  IdentityErrorCode,
  OrgStoreRecord,
  OrgStoreRepository,
  PinChallengeRecord,
  PinChallengeRepository,
  PinLockoutRecord,
  PinLockoutRepository,
  RefreshCookieMaterial,
  RefreshFamilyRecord,
  RefreshRepository,
  RefreshTokenRecord,
  SessionIssueResult,
  SessionRecord,
  SessionRepository,
  StaffRecord,
  StaffRepository,
  Uuid,
} from "./types.js";
