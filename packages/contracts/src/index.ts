export {
  AmountMeasureSchema,
  BatchMeasureSchema,
  LimitConfigurationSchema,
  PositiveSafeIntegerSchema,
  QueryResultLimitOverrideSchema,
  SizeMeasuresSchema,
  ThresholdsSchema,
  validateStricterLimitOverride,
  validateStricterQueryResultLimitOverride,
} from "./registry/limits.js";
export type {
  EffectiveQueryResultLimit,
  LimitGroups,
  QueryResultLimitOverride,
} from "./registry/limits.js";

export {
  CommandNameSchema,
  ContractExampleSchema,
  ContractExamplesSchema,
  ExampleArgsSchema,
  JsonPointerSchema,
  RedactionRuleSchema,
  RedactionRulesSchema,
  SafePropertyKeySchema,
  SemVerSchema,
  StableBindingIdSchema,
  StableBindingIdsSchema,
} from "./registry/primitives.js";
export type { ContractExample, RedactionRule } from "./registry/primitives.js";

export {
  CommandDataClassificationSchema,
  CommandMetadataSchema,
  DataClassificationSchema,
  getInputAuditDisposition,
  InputRedactionRuleSchema,
  OfflineModeSchema,
  PII_QUERY_MAX_RESULT_ROWS,
  QueryDataClassificationSchema,
  QueryMetadataSchema,
  QueryRiskSchema,
  ResultRedactionRuleSchema,
  RiskSchema,
} from "./registry/schemas.js";
export type {
  CommandMetadata,
  DataClassification,
  InputRedactionRule,
  OfflineMode,
  QueryMetadata,
  QueryRisk,
  ResultRedactionRule,
  Risk,
} from "./registry/schemas.js";

export {
  defineCommand,
  defineQuery,
  isAiProjectableDefinition,
  isContractDefinition,
  parseContractInput,
} from "./registry/definitions.js";
export type {
  AiProjectableDefinition,
  CommandDefinition,
  ContractDefinition,
  InferContractInput,
  InferContractOutput,
  QueryDefinition,
} from "./registry/definitions.js";

export {
  CommandWirePayloadSchema,
  ConfirmReferenceSchema,
  IdempotencyKeySchema,
  parseCommandWirePayload,
  WireArgumentsSchema,
} from "./envelope/wire-payload.js";
export type {
  CommandWirePayload,
  ConfirmCommandWirePayload,
  DirectCommandWirePayload,
} from "./envelope/wire-payload.js";

export {
  CommandViaSchema,
  injectAuthenticatedCommandContext,
  isServerCommandEnvelope,
} from "./envelope/server-envelope.js";
export type { ServerCommandEnvelope } from "./envelope/server-envelope.js";

export {
  ACCESS_TOKEN_TTL_SECONDS,
  AccessTokenClaimsSchema,
  AuthenticationMethodSchema,
  BrowserCommandViaSchema,
  isAuthenticatedExecutionSource,
  isBrowserSessionSource,
  isEdgeReplaySource,
  parseAccessTokenClaims,
  ServerSessionRecordSchema,
} from "./auth/session.js";
export type {
  AccessTokenClaims,
  AuthenticatedActor,
  AuthenticatedExecutionSource,
  AuthenticatedTenant,
  BrowserCommandVia,
  BrowserSessionSource,
  ServerSessionRecord,
} from "./auth/session.js";
export type { EdgeReplaySource } from "./auth/edge-ingress.js";

export {
  CommandErrorCodeSchema,
  CommandErrorSchema,
  CommandResponseSchema,
  createCommandError,
} from "./envelope/responses.js";
export type {
  CommandError,
  CommandErrorCode,
  CommandErrorDetail,
  CommandResponse,
} from "./envelope/responses.js";

export {
  TENANT_TABLE_MATRIX,
  getTenantTableDescriptor,
  getTenantTableScope,
  isTenantTableDescriptor,
} from "./tenant/table-matrix.js";
export type {
  GlobalScopeTableName,
  OrgScopeTableName,
  StoreScopeTableName,
  TenantTableDescriptor,
  TenantTableScope,
  V2TableName,
} from "./tenant/table-matrix.js";

export {
  GARMENTS_ORDER_FOREIGN_KEY,
  GARMENTS_ORDER_LINE_FOREIGN_KEY,
  ORDER_LINES_ORDER_FOREIGN_KEY,
  ORDER_LINE_UNIQUE_KEY_COLUMNS,
  PAYMENTS_ORDER_FOREIGN_KEY,
  STORE_ENTITY_UNIQUE_KEY_COLUMNS,
  defineTenantForeignKey,
  defineTenantUniqueKey,
  isTenantForeignKeyDescriptor,
  isTenantUniqueKeyDescriptor,
} from "./tenant/keys.js";
export type { TenantForeignKeyDescriptor, TenantUniqueKeyDescriptor } from "./tenant/keys.js";

export {
  ORG_TENANT_PREDICATE_SQL,
  STORE_TENANT_PREDICATE_SQL,
  buildMaintenancePolicySql,
  buildOrgTenantPolicySql,
  buildStoreTenantPolicySql,
} from "./tenant/rls-templates.js";
export type { MaintenancePolicySqlInput, TenantPolicySqlInput } from "./tenant/rls-templates.js";

export {
  canonicalizeCapabilityTicketForSigning,
  canonicalizeExecutionReceiptForSigning,
  canonicalizeForSignatureVerification,
  canonicalizeOfflineGrantForSigning,
  canonicalizePrimaryLeaseForSigning,
} from "./edge/canonical.js";

export {
  Base64UrlSignatureSchema,
  EdgeCapabilityActionSchema,
  EdgeExecutionResultSchema,
  EdgeNonceSchema,
  EdgeOriginSchema,
  ExactUtcTimestampSchema,
} from "./edge/primitives.js";

export {
  CapabilityTicketPayloadSchema,
  ExecutionReceiptPayloadSchema,
  OFFLINE_GRANT_MAX_TTL_MS,
  OfflineGrantPayloadSchema,
  PrimaryLeasePayloadSchema,
} from "./edge/protocols.js";
export type {
  CapabilityTicketPayload,
  ExecutionReceiptPayload,
  OfflineGrantPayload,
  PrimaryLeasePayload,
} from "./edge/protocols.js";

export {
  createOfflineGrantRegistrySnapshot,
  isOfflineGrantRegistrySnapshot,
  validateOfflineGrantAllowedCommands,
} from "./edge/offline-grant.js";
export type {
  OfflineGrantAuthorizationSummary,
  OfflineGrantDefinitionReference,
  OfflineGrantRegistrySnapshot,
} from "./edge/offline-grant.js";

export {
  isDeviceSignatureExecutionReceiptCandidate,
  isServerSignatureCapabilityTicketCandidate,
  isServerSignatureOfflineGrantCandidate,
  isServerSignaturePrimaryLeaseCandidate,
  parseDeviceSignatureExecutionReceiptCandidate,
  parseServerSignatureCapabilityTicketCandidate,
  parseServerSignatureOfflineGrantCandidate,
  parseServerSignaturePrimaryLeaseCandidate,
} from "./edge/signed-envelope.js";
export type {
  DeviceSignatureExecutionReceiptCandidate,
  EdgeSignatureCandidate,
  ServerSignatureCapabilityTicketCandidate,
  ServerSignatureOfflineGrantCandidate,
  ServerSignaturePrimaryLeaseCandidate,
} from "./edge/signed-envelope.js";

export {
  classifyQueueEnvelopeCompatibility,
  parseEdgeQueueEnvelope,
  QueueAuthorizationSchema,
} from "./edge/queue-envelope.js";
export type {
  EdgeQueueEnvelope,
  QueueAuthorization,
  QueueEnvelopeVersionDisposition,
} from "./edge/queue-envelope.js";
