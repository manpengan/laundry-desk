import { z } from "zod";

import { CSRF_HEADER_NAME } from "../auth/csrf.js";
import {
  CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME,
  CustomerPortalEmptyInputSchema,
  CustomerPortalLoginInputSchema,
  CustomerPortalProfileMutationResultSchema,
  CustomerPortalProfileUpdateInputSchema,
  CustomerPortalSessionSchema,
} from "../commands/customer-self-service.js";

const ref = (name: string) => Object.freeze({ $ref: `#/components/schemas/${name}` });
const content = (name: string) =>
  Object.freeze({ "application/json": Object.freeze({ schema: ref(name) }) });
const cacheControl = Object.freeze({
  description: "Every customer authentication response is non-cacheable.",
  schema: Object.freeze({ type: "string", const: "no-store" }),
});
const cookieHeader = (description: string) =>
  Object.freeze({
    description,
    schema: Object.freeze({
      type: "array",
      items: Object.freeze({ type: "string" }),
    }),
  });
const headers = (effect: "clear" | "none" | "set" = "none") =>
  Object.freeze({
    "Cache-Control": cacheControl,
    ...(effect === "set"
      ? {
          "Set-Cookie": cookieHeader(
            "Two authority-selected host-only cookies are set: HttpOnly session and readable CSRF.",
          ),
        }
      : effect === "clear"
        ? {
            "Set-Cookie": cookieHeader(
              "When the authority header is valid, two selected cookies are cleared with Max-Age=0; pre-route rejection has no cookie side effect.",
            ),
          }
        : {}),
  });
const success = (name: string, description: string, effect: "clear" | "none" | "set" = "none") =>
  Object.freeze({ description, content: content(name), headers: headers(effect) });
const failure = (description: string, effect: "clear" | "none" = "none") =>
  Object.freeze({
    description,
    content: content("CommandFailureResponse"),
    headers: headers(effect),
  });
const rateLimited = Object.freeze({
  ...failure("Rate limit exceeded"),
  headers: Object.freeze({
    ...headers(),
    "Retry-After": Object.freeze({
      description: "Seconds until this bounded source/session bucket may retry.",
      schema: Object.freeze({ type: "integer", minimum: 1 }),
    }),
  }),
});

const authorityParameter = Object.freeze({
  name: CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME,
  in: "header" as const,
  required: true,
  description:
    "Per-tab 256-bit customer authority from sessionStorage; selects and must match the bound customer cookie.",
  schema: Object.freeze({ type: "string", pattern: "^v1\\.[A-Za-z0-9_-]{43}$" }),
});
const csrfParameter = Object.freeze({
  name: CSRF_HEADER_NAME,
  in: "header" as const,
  required: true,
  description: "Double-submit CSRF proof; must match the authority-selected readable cookie.",
  schema: Object.freeze({ type: "string", pattern: "^v1\\.[A-Za-z0-9_-]{43,128}$" }),
});

const sessionSecurity = Object.freeze([
  Object.freeze({ customerSession: Object.freeze([]), customerTabAuthority: Object.freeze([]) }),
]);
const mutationSecurity = Object.freeze([
  Object.freeze({
    customerSession: Object.freeze([]),
    customerTabAuthority: Object.freeze([]),
    customerCsrfCookie: Object.freeze([]),
    csrfHeader: Object.freeze([]),
  }),
]);

const base = (operationId: string, summary: string) => ({
  operationId,
  summary,
  description:
    "Dedicated customer authentication boundary. Every credential response is no-store and source/session rate limits return Retry-After.",
  tags: Object.freeze(["customer-auth"]),
  "x-laundry-kind": "auth" as const,
});

export const CUSTOMER_PORTAL_OPENAPI = Object.freeze({
  csrfParameter,
  authorityParameter,
  authorityScheme: Object.freeze({
    type: "apiKey" as const,
    in: "header" as const,
    name: CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME,
    description: "High-entropy per-tab authority; only its SHA-256 hash is stored server-side.",
  }),
  sessionScheme: Object.freeze({
    type: "apiKey" as const,
    in: "cookie" as const,
    name: "__Host-laundry_customer_session_<sha256-selector>",
    description: "Authority-selected, 15-minute HttpOnly customer session cookie.",
  }),
  csrfCookieScheme: Object.freeze({
    type: "apiKey" as const,
    in: "cookie" as const,
    name: "__Host-laundry_customer_csrf_<sha256-selector>",
    description: "Authority-selected readable cookie paired with x-csrf-token.",
  }),
});

export const CUSTOMER_PORTAL_AUTH_SCHEMAS = Object.freeze({
  CustomerPortalLoginInput: CustomerPortalLoginInputSchema,
  CustomerPortalEmptyInput: CustomerPortalEmptyInputSchema,
  CustomerPortalSessionResponse: z.strictObject({
    ok: z.literal(true),
    data: CustomerPortalSessionSchema,
  }),
  CustomerPortalLogoutResponse: z.strictObject({
    ok: z.literal(true),
    data: z.strictObject({ logged_out: z.literal(true) }),
  }),
  CustomerPortalProfileUpdateInput: CustomerPortalProfileUpdateInputSchema,
  CustomerPortalProfileMutationResponse: z.strictObject({
    ok: z.literal(true),
    data: CustomerPortalProfileMutationResultSchema,
  }),
});

export const CUSTOMER_PORTAL_AUTH_PATHS = Object.freeze({
  "/api/v2/customer/auth/login": Object.freeze({
    post: Object.freeze({
      ...base("customer_auth_login", "Customer portal login"),
      parameters: Object.freeze([authorityParameter]),
      requestBody: Object.freeze({
        required: true as const,
        content: content("CustomerPortalLoginInput"),
      }),
      responses: Object.freeze({
        "200": success("CustomerPortalSessionResponse", "Authenticated customer session", "set"),
        "400": failure("Invalid request"),
        "401": failure("Authentication failed without enumeration detail"),
        "403": failure("Browser origin rejected"),
        "415": failure("JSON media type required"),
        "429": rateLimited,
        "500": failure("Authentication transaction failed"),
        default: failure("Unified failure envelope"),
      }),
      security: Object.freeze([Object.freeze({ customerTabAuthority: Object.freeze([]) })]),
    }),
  }),
  "/api/v2/customer/auth/session": Object.freeze({
    get: Object.freeze({
      ...base("customer_auth_session", "Resume customer portal session"),
      parameters: Object.freeze([authorityParameter]),
      responses: Object.freeze({
        "200": success("CustomerPortalSessionResponse", "Active customer session"),
        "400": failure("Request metadata rejected"),
        "401": failure("Authentication failed", "clear"),
        "429": rateLimited,
        "500": failure("Session lookup failed"),
        default: failure("Unified failure envelope"),
      }),
      security: sessionSecurity,
    }),
  }),
  "/api/v2/customer/auth/logout": Object.freeze({
    post: Object.freeze({
      ...base("customer_auth_logout", "Revoke customer portal session"),
      parameters: Object.freeze([authorityParameter, csrfParameter]),
      requestBody: Object.freeze({
        required: true as const,
        content: content("CustomerPortalEmptyInput"),
      }),
      responses: Object.freeze({
        "200": success("CustomerPortalLogoutResponse", "Customer session revoked", "clear"),
        "400": failure("Request metadata or strict empty body rejected", "clear"),
        "401": failure("Authentication failed", "clear"),
        "403": failure("Browser origin or CSRF rejected", "clear"),
        "415": failure("JSON media type required"),
        "500": failure("Logout transaction failed", "clear"),
        default: failure("Unified failure envelope", "clear"),
      }),
      security: mutationSecurity,
    }),
  }),
  "/api/v2/customer/profile": Object.freeze({
    post: Object.freeze({
      operationId: "customer_profile_update",
      summary: "Update customer-owned addresses and notification preference",
      description:
        "Dedicated customer-session CAS. The server derives the canonical customer, preserves store-managed addresses, and records only count, preference and version evidence. It does not claim a notification was sent.",
      tags: Object.freeze(["customer-profile"]),
      "x-laundry-kind": "auth" as const,
      parameters: Object.freeze([authorityParameter, csrfParameter]),
      requestBody: Object.freeze({
        required: true as const,
        content: content("CustomerPortalProfileUpdateInput"),
      }),
      responses: Object.freeze({
        "200": success("CustomerPortalProfileMutationResponse", "Profile preference updated"),
        "400": failure("Strict profile body or request metadata rejected"),
        "401": failure("Customer session unavailable or expired"),
        "403": failure("Browser origin or CSRF rejected"),
        "409": failure("Profile version or preserved-address constraint changed"),
        "415": failure("JSON media type required"),
        "429": rateLimited,
        "500": failure("Profile transaction failed"),
        default: failure("Unified failure envelope"),
      }),
      security: mutationSecurity,
    }),
  }),
});
