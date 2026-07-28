// Curated public entry point. Each domain barrel re-exports only the names that
// belong on the root surface, so `export *` here can never widen the public API
// beyond what those barrels name explicitly.
export * from "./registry/index.js";
export * from "./envelope/index.js";
export * from "./auth/index.js";
export * from "./desktop/index.js";
export * from "./tenant/index.js";
export * from "./edge/index.js";
export * from "./commands/index.js";
export * from "./openapi/index.js";

// Restricted auth authority modules stay wired to this entry point only. The
// `auth/` barrel deliberately excludes them so it never becomes a second route
// to the identity-lifecycle authority or the edge ingress — see the allowlist in
// tests/foundation/workspace.test.mjs.
export type { EdgeReplaySource } from "./auth/edge-ingress.js";
export {
  AUTH_OPERATION_MATRIX,
  AccessSessionResponseSchema,
  EmptyBodySchema,
  IdentityLifecycleOperationSchema,
  LoginRequestSchema,
  LogoutResponseSchema,
  PinChallengeRequestSchema,
  PinChallengeResponseSchema,
  PinVerifyRequestSchema,
  PinVerifyResponseSchema,
  isIdentityLifecycleEnvelope,
} from "./auth/operations.js";
export type {
  AccessSessionResponse,
  AuthOperationDescriptor,
  EmptyBody,
  IdentityLifecycleEnvelope,
  LoginRequest,
  PinChallengeRequest,
  PinVerifyRequest,
} from "./auth/operations.js";
