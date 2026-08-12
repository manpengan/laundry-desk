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
  HandlerCommandError,
  MemoryIdempotencyStore,
  createPgIdempotencyStore,
  runCommandChain,
} from "./bus/index.js";

export type {
  ActorContext,
  BusContext,
  ChainPortHooks,
  CommandHandler,
  CommandIdempotencyStore,
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
  TransactionalIdempotencyStore,
  MutableCommandRegistry,
  RegisteredCommand,
} from "./bus/index.js";

export { INSERT_AUDIT_LOG_SQL, auditWriterIsInsertOnly, writeAudit } from "./audit/write-audit.js";
export type { AuditWriteRecord } from "./audit/write-audit.js";

export {
  createMemoryStoreManagementDeps,
  createMemoryStoreManagementStore,
  createPgStoreManagementDeps,
  createPgStoreManagementStore,
  createStoreManagementHandlers,
  registerStoreManagementHandlers,
} from "./store-management/index.js";
export type {
  AuthorizedStoreDirectory,
  StoreManagementHandlerDeps,
  StoreManagementStore,
  StoreProfileSnapshot,
  StoreProfileUpdateResult,
} from "./store-management/index.js";

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
  ARGON2ID_DEFAULTS,
  createArgon2idPasswordPort,
  createPasswordPort,
  createScryptPasswordPort,
  createSessionService,
  createTestPasswordPort,
  hashOpaqueSecret,
  issueSession,
  loginWithPassword,
  logoutSession,
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
  SessionIssueReplacement,
  SessionLifecycleIssue,
  SessionLifecycleRefreshDisposition,
  SessionLifecycleRefreshUse,
  SessionLifecycleRepository,
  SessionLifecycleRevocation,
  SessionPredecessor,
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
  createCsrfProofSigner,
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
  CsrfProofBinding,
  CsrfProofSigner,
  ForbiddenTenantHeader,
  ResolveSessionDeps,
  ResolveSessionInput,
} from "./auth/index.js";

export {
  AI_PRESET_WHITELISTS,
  listToolNames,
  listTools,
  projectCatalogToTools,
  projectDefinitionToTool,
} from "./tools/index.js";
export type {
  JsonSchemaProjection,
  ListToolsFilter,
  LlmToolDescriptor,
  LlmToolLimits,
  ToolExample,
} from "./tools/index.js";

export * from "./catalog/index.js";

export {
  createPlatformHandlers,
  platformHandlerNames,
  registerPlatformCommandHandlers,
} from "./platform/index.js";
export type {
  PlatformHandlerDeps,
  PlatformHandlerMap,
  PlatformHandlerName,
  SettingsEntry,
  SettingsStore,
  FeaturesStore,
  StoreFeatureFlags,
  AuditListFilter,
  AuditListItem,
  AuditQueryStore,
} from "./platform/index.js";

export {
  actorPermissionSet,
  createDefaultChainHooks,
  createIdentityHandlers,
  createRegisteredM1Bus,
  defaultCheckInvariants,
  defaultCheckPolicy,
  defaultCheckRbac,
  defaultCheckTenant,
  identityHandlerNames,
  registerIdentityCommandHandlers,
  registerM1Handlers,
  registerPlatformHandlers,
  requiredPermissionsFromInvariants,
  toAccessSessionResponse,
} from "./handlers/index.js";

export {
  createMemoryFulfillmentStore,
  createPgFulfillmentStore,
  createFulfillmentConfirmationPreparer,
  registerFulfillmentCommandHandlers,
  registerFulfillmentQueryHandlers,
} from "./fulfillment/index.js";
export type {
  FulfillmentHandlerDeps,
  FulfillmentIncidentInput,
  FulfillmentIncidentKind,
  FulfillmentIncidentResult,
  FulfillmentStore,
  FulfillmentTransitionInput,
  FulfillmentTransitionRow,
  FulfillmentWorkbenchOptions,
  FulfillmentWorkbenchRow,
  FactoryBatchDetailResult,
  FactoryBatchListResult,
  FactoryBatchStatus,
  FactoryCheckpoint,
  FactoryConfirmationSummary,
  FactoryCustodyState,
  FactoryHandoffStore,
  FactoryManifestRow,
  FactoryMemberState,
  FactoryQcStatus,
  MemoryFulfillmentSeed,
} from "./fulfillment/index.js";
export type {
  IdentityHandlerDeps,
  IdentityHandlerMap,
  IdentityHandlerName,
  IdentitySessionBinding,
  RegisterM1Deps,
  RegisterM1Result,
} from "./handlers/index.js";

export {
  checkPolicy,
  createStepUpProof,
  evaluatePolicy,
  policyDecisionToPortError,
  STEP_UP_PROOF_TTL_SECONDS,
  verifyStepUpProof,
} from "./policy/index.js";

export type {
  EvaluatePolicyInput,
  PolicyActor,
  PolicyCommandMeta,
  PolicyDecision,
  PolicyDecisionAllow,
  PolicyDecisionConfirm,
  PolicyDecisionDeny,
  PolicyDecisionStepUp,
  PolicyDenyReason,
  PolicyOutcome,
  PolicyPortError,
  PolicyRiskInput,
  StepUpProof,
  StepUpProofStatus,
  StepUpVerifyRejectReason,
  StepUpVerifyResult,
} from "./policy/index.js";

export {
  canonicalize,
  freezeCanonical,
  hashCanonical,
  MemoryPendingActionStore,
  createPgPendingActionStore,
  PENDING_ACTION_TTL_SECONDS,
} from "./pending-actions/index.js";

export { createPgStepUpProofStore } from "./identity/pg-step-up-proof-store.js";

export type {
  CanonicalJson,
  ConsumeFailure,
  ConsumeRejectReason,
  ConsumeResult,
  ConsumeSuccess,
  CreatePendingActionInput,
  EntityVersion,
  PendingAction,
  PendingActionReadContext,
  PendingActionStatus,
  PendingActionStore,
  PendingActionTransactionContext,
} from "./pending-actions/index.js";

export { createLocalApp } from "./http/create-app.js";
export type { CreateAppOptions } from "./http/create-app.js";
export { createLocalRuntime, DEMO_PASSWORD, DEMO_PIN } from "./local/demo-seed.js";
export type { LocalRuntime } from "./local/demo-seed.js";

export {
  buildAccountingCsv,
  createAccountingHandlers,
  createMemoryAccountingSource,
  createPgAccountingSource,
  escapeAccountingCsvCell,
  registerAccountingHandlers,
} from "./accounting/index.js";
export type {
  AccountingHandlerDeps,
  AccountingReadPort,
  AccountingReadRequest,
  MemoryAccountingSourceInput,
} from "./accounting/index.js";

export {
  OWNER_DASHBOARD_OVERDUE_DAYS,
  OWNER_DASHBOARD_TREND_DAYS,
  buildOwnerCardMetrics,
  buildOwnerDashboardResult,
  buildOwnerDrilldownResult,
  buildOwnerPortfolioResult,
  createMemoryOwnerDashboardSource,
  createMemoryReportingDeps,
  createPgOwnerDashboardSource,
  createPgReportingDeps,
  createReportingHandlers,
  registerReportingQueryHandlers,
} from "./reporting/index.js";
export type {
  OwnerDashboardOperations,
  OwnerDashboardDrilldownReadRequest,
  OwnerDashboardDrilldownSnapshot,
  OwnerDashboardReadPort,
  OwnerDashboardReadRequest,
  OwnerPortfolioStoreCandidate,
  OwnerPortfolioStoreScopeRequest,
  OwnerPortfolioStoreSnapshot,
  ReportingHandlerDeps,
} from "./reporting/index.js";

export {
  buildNotificationCsv,
  createMemoryNotificationStore,
  createNotificationHandlers,
  createPgNotificationStore,
  registerNotificationHandlers,
} from "./notification/index.js";
export type {
  NotificationHandlerDeps,
  NotificationLogWrite,
  NotificationStore,
  PickupReminderFilters,
  PickupReminderListRequest,
} from "./notification/index.js";

export * from "./marketing/index.js";
