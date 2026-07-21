/**
 * C8 auth middleware ports (pure resolve + CSRF). Fastify plugin wiring is residual.
 */

export { AuthError, FORBIDDEN_TENANT_AUTHORITY_HEADERS } from "./context.js";
export type { AuthActor, AuthContext, AuthTenant, ForbiddenTenantHeader } from "./context.js";

export {
  assertNoTenantAuthorityHeaders,
  createSessionResolver,
  resolveSessionFromBearer,
} from "./resolve-session.js";
export type { ResolveSessionDeps, ResolveSessionInput } from "./resolve-session.js";

export {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  assertCsrf,
  checkCsrfDoubleSubmit,
  readCsrfHeader,
} from "./csrf.js";
export type { CsrfCheckInput, CsrfCheckResult } from "./csrf.js";
