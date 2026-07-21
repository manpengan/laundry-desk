/**
 * @laundry/server public surface.
 * C2 tenant GUC ports + C1 command bus + C3 append-only audit + C6 identity + C8 auth skeleton.
 * Fastify HTTP plugins and identity bus handlers are residual (not wired here).
 */
export {
  RLS_BYPASS_CLASSES,
  RlsBypassError,
  TENANT_GUC_KEYS,
  TenantGucError,
  buildSetLocalGucStatements,
  isRlsBypassClass,
  isUuid,
  noopBypassAudit,
  parseTenantContext,
  requestRlsBypass,
  withTenantTransaction,
  withWorkerTenantTransaction,
} from "./db/index.js";

export type {
  BypassAuditEvent,
  BypassAuditSink,
  QueryResult,
  RequestBypassInput,
  RlsBypassClass,
  RlsBypassGrant,
  SetLocalGucStatement,
  SqlClient,
  TenantContext,
  TenantGucKey,
  TenantTransactionFn,
  TransactionalClient,
  Uuid,
} from "./db/index.js";

export {
  createM1CommandRegistry,
  createChainPorts,
  executeCommand,
  MemoryIdempotencyStore,
  runCommandChain,
} from "./bus/index.js";

export type {
  ActorContext,
  BusContext,
  ChainPortHooks,
  CommandHandler,
  CommandRegistry,
  CommandRequest,
  CommandResult,
  CommandVia,
  DomainEvent,
  EventBus,
  ExecuteCommandOptions,
  HandlerContext,
  HandlerOutcome,
  IdempotencyStore,
  MutableCommandRegistry,
  RegisteredCommand,
} from "./bus/index.js";

export { INSERT_AUDIT_LOG_SQL, auditWriterIsInsertOnly, writeAudit } from "./audit/write-audit.js";
export type { AuditWriteRecord } from "./audit/write-audit.js";

export {
  BUS_ONLY_PATH_PREFIXES,
  FORBIDDEN_IMPORT_PATTERNS,
  findForbiddenImports,
  isBusOnlyPath,
  scanImportBoundary,
} from "./architecture/import-boundary.js";
export type { BoundaryScanResult, BoundaryViolation } from "./architecture/import-boundary.js";

export {
  IdentityError,
  PIN_LOCKOUT_SECONDS,
  buildAccessClaims,
  constantTimeEqual,
  createAccessTokenSigner,
  createLoginService,
  createMemoryIdentityStore,
  createPinService,
  createScryptPasswordPort,
  createSessionService,
  createTestPasswordPort,
  hashOpaqueSecret,
  issueSession,
  loginWithPassword,
  logoutSession,
  mintCsrfProof,
  newUuid,
  randomToken,
  rotateRefresh,
  sha256Hex,
  createQuickSwitchChallenge,
  verifyQuickSwitchPin,
} from "./identity/index.js";

export type {
  AccessTokenSigner,
  AuthenticationMethod,
  CsrfCookieMaterial,
  EpochSeconds,
  IdGenerator,
  IdentityClock,
  IdentityErrorCode,
  IssueSessionInput,
  LoginResult,
  LoginServiceDeps,
  LogoutResult,
  MemoryIdentityStore,
  OrgStoreRecord,
  OrgStoreRepository,
  PasswordPort,
  PinChallengeRecord,
  PinChallengeRepository,
  PinChallengeView,
  PinLockoutRecord,
  PinLockoutRepository,
  PinPort,
  PinServiceDeps,
  RefreshCookieMaterial,
  RefreshFamilyRecord,
  RefreshRepository,
  RefreshResult,
  RefreshTokenRecord,
  SessionIssueResult,
  SessionRecord,
  SessionRepository,
  SessionServiceDeps,
  StaffRecord,
  StaffRepository,
  CreatePinChallengeInput,
  VerifyPinInput,
} from "./identity/index.js";

export {
  AuthError,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  FORBIDDEN_TENANT_AUTHORITY_HEADERS,
  assertCsrf,
  assertNoTenantAuthorityHeaders,
  checkCsrfDoubleSubmit,
  createSessionResolver,
  readCsrfHeader,
  resolveSessionFromBearer,
} from "./auth/index.js";

export type {
  AuthActor,
  AuthContext,
  AuthTenant,
  CsrfCheckInput,
  CsrfCheckResult,
  ForbiddenTenantHeader,
  ResolveSessionDeps,
  ResolveSessionInput,
} from "./auth/index.js";
