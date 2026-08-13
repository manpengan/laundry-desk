import type { FastifyRequest } from "fastify";

import {
  CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME,
  CustomerPortalAuthoritySchema,
} from "@laundry/contracts";

import type {
  CustomerPortalQueryRateLimiter,
  CustomerPortalSessionIdentity,
  CustomerPortalStore,
} from "../customer-self-service/index.js";
import type { CustomerPortalLoginTimingGuard } from "../customer-self-service/login-timing.js";
import type { CookiePolicy } from "./cookie-policy.js";
import {
  customerPortalHashMatches,
  customerPortalSessionSecret,
  hashCustomerPortalSecret,
} from "./customer-portal-cookie.js";
import type { LoginRateLimiter } from "./login-rate-limit.js";
import type { LocalRequestSecurityPolicy } from "./request-security.js";
import { trustedClientSource } from "./request-security.js";

export type CustomerPortalRouteDeps = Readonly<{
  store: CustomerPortalStore;
  cookiePolicy: CookiePolicy;
  loginRateLimiter: LoginRateLimiter;
  loginTimingGuard: CustomerPortalLoginTimingGuard;
  queryRateLimiter: CustomerPortalQueryRateLimiter;
  requestSecurity: LocalRequestSecurityPolicy;
}>;

export function customerPortalTabAuthority(request: FastifyRequest): string | null {
  const value = request.headers[CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME];
  const parsed = CustomerPortalAuthoritySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function resolveCustomerPortalIdentity(
  request: FastifyRequest,
  deps: CustomerPortalRouteDeps,
): Promise<Readonly<{
  identity: CustomerPortalSessionIdentity;
  secret: string;
  source: string;
}> | null> {
  const source = trustedClientSource(request, deps.requestSecurity);
  if (source === null) return null;
  const authority = customerPortalTabAuthority(request);
  if (authority === null) return null;
  const secret = customerPortalSessionSecret(request, deps.cookiePolicy, authority);
  if (secret === null) return null;
  const identity = await deps.store.resolveSession(hashCustomerPortalSecret(secret));
  return identity === null || !customerPortalHashMatches(authority, identity.authorityHash)
    ? null
    : Object.freeze({ identity, secret, source });
}
