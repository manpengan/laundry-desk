import { isIP } from "node:net";

import type { FastifyInstance, FastifyRequest } from "fastify";

import { createCommandError } from "@laundry/contracts";

type HeaderValue = string | readonly string[] | undefined;

export type LocalRequestSecurityOptions = Readonly<{
  allowedHosts: readonly string[];
  browserOrigin: string;
  browserFetchSite: "same-site" | "same-origin";
  desktopOrigin: string;
  trustedProxyClientIpRequired?: boolean;
}>;

export type LocalRequestSecurityPolicy = Readonly<{
  allowedHosts: readonly string[];
  browserOrigin: string;
  browserFetchSite: "same-site" | "same-origin";
  desktopOrigin: string;
  corsOrigin: string;
  trustedProxyClientIpRequired: boolean;
}>;

export type RequestSecurityInput = Readonly<{
  method: string;
  url?: string;
  headers: Readonly<Record<string, HeaderValue>>;
}>;

export type RequestSecurityDecision =
  Readonly<{ allowed: true }> | Readonly<{ allowed: false; statusCode: 400 | 403 | 415 }>;

const SAFE_METHODS = Object.freeze(["GET", "HEAD", "OPTIONS"] as const);
export const TRUSTED_PROXY_CLIENT_IP_HEADER_NAME = "x-laundry-proxy-client-ip" as const;
const UNTRUSTED_SOURCE_HEADERS = Object.freeze(
  new Set(["cf-connecting-ip", "true-client-ip", "x-real-ip"]),
);
const ALLOWED = Object.freeze({ allowed: true as const });
const BAD_REQUEST = Object.freeze({ allowed: false as const, statusCode: 400 as const });
const FORBIDDEN = Object.freeze({ allowed: false as const, statusCode: 403 as const });
const UNSUPPORTED_MEDIA_TYPE = Object.freeze({
  allowed: false as const,
  statusCode: 415 as const,
});
const PUBLIC_FAILURE = Object.freeze({
  ok: false as const,
  error: createCommandError("VALIDATION_FAILED"),
});

function headerValues(
  headers: RequestSecurityInput["headers"],
  expectedName: string,
): readonly string[] {
  return Object.entries(headers).flatMap(([name, value]) => {
    if (name.toLowerCase() !== expectedName || value === undefined) return [];
    return typeof value === "string" ? [value] : [...value];
  });
}

function hasUntrustedSourceMetadata(headers: RequestSecurityInput["headers"]): boolean {
  return Object.entries(headers).some(([name, value]) => {
    if (value === undefined) return false;
    const normalized = name.toLowerCase();
    return (
      normalized === "forwarded" ||
      normalized.startsWith("x-forwarded-") ||
      UNTRUSTED_SOURCE_HEADERS.has(normalized)
    );
  });
}

function isExactAuthority(authority: string): boolean {
  if (authority.length === 0 || authority.trim() !== authority || authority === "*") return false;
  try {
    const parsed = new URL(`http://${authority}`);
    return (
      parsed.host === authority &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

function isExactOrigin(origin: string, protocols: readonly string[]): boolean {
  if (origin.length === 0 || origin.trim() !== origin || origin === "*" || origin === "null") {
    return false;
  }
  try {
    const parsed = new URL(origin);
    return (
      protocols.includes(parsed.protocol) &&
      parsed.host.length > 0 &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      origin === `${parsed.protocol}//${parsed.host}`
    );
  } catch {
    return false;
  }
}

function hasValidOptions(options: LocalRequestSecurityOptions): boolean {
  const hosts = [...options.allowedHosts];
  let desktopHost: string;
  try {
    desktopHost = new URL(options.desktopOrigin).host;
  } catch {
    return false;
  }
  return (
    hosts.length > 0 &&
    new Set(hosts).size === hosts.length &&
    hosts.every(isExactAuthority) &&
    isExactOrigin(options.browserOrigin, ["http:", "https:"]) &&
    (options.browserFetchSite === "same-site" || options.browserFetchSite === "same-origin") &&
    isExactOrigin(options.desktopOrigin, ["http:", "https:"]) &&
    hosts.includes(desktopHost) &&
    options.browserOrigin !== options.desktopOrigin &&
    (options.trustedProxyClientIpRequired === undefined ||
      typeof options.trustedProxyClientIpRequired === "boolean")
  );
}

export function createRequestSecurityPolicy(
  options: LocalRequestSecurityOptions,
): LocalRequestSecurityPolicy {
  if (!hasValidOptions(options)) {
    throw new Error("Invalid local request security configuration");
  }

  const allowedHosts = Object.freeze([...options.allowedHosts]);
  return Object.freeze({
    allowedHosts,
    browserOrigin: options.browserOrigin,
    browserFetchSite: options.browserFetchSite,
    desktopOrigin: options.desktopOrigin,
    corsOrigin: options.browserOrigin,
    trustedProxyClientIpRequired: options.trustedProxyClientIpRequired ?? false,
  });
}

function isLoopbackPeer(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    /^127(?:\.\d{1,3}){3}$/u.test(normalized) ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("::ffff:127.")
  );
}

function proxyClientIp(
  headers: RequestSecurityInput["headers"],
  peerAddress: string,
): string | null | undefined {
  const values = headerValues(headers, TRUSTED_PROXY_CLIENT_IP_HEADER_NAME);
  if (values.length === 0) return undefined;
  const value = values.length === 1 ? values[0] : undefined;
  return value !== undefined && isLoopbackPeer(peerAddress) && isIP(value) !== 0 ? value : null;
}

/** Resolve the rate-limit source without enabling Fastify's generic proxy trust. */
export function trustedClientSource(
  request: Pick<FastifyRequest, "headers" | "ip">,
  policy: LocalRequestSecurityPolicy,
): string | null {
  const proxied = proxyClientIp(request.headers, request.ip);
  if (proxied === null) return null;
  if (proxied !== undefined) return proxied;
  return policy.trustedProxyClientIpRequired ? null : request.ip;
}

function hasAllowedHost(
  headers: RequestSecurityInput["headers"],
  policy: LocalRequestSecurityPolicy,
): boolean {
  const hosts = headerValues(headers, "host");
  return hosts.length === 1 && policy.allowedHosts.includes(hosts[0] as string);
}

function hasAllowedOriginPair(
  headers: RequestSecurityInput["headers"],
  policy: LocalRequestSecurityPolicy,
): boolean {
  const origins = headerValues(headers, "origin");
  const fetchSites = headerValues(headers, "sec-fetch-site");
  if (origins.length !== 1 || fetchSites.length !== 1) return false;

  return (
    (origins[0] === policy.browserOrigin && fetchSites[0] === policy.browserFetchSite) ||
    (origins[0] === policy.desktopOrigin && fetchSites[0] === "same-origin")
  );
}

function mediaType(headers: RequestSecurityInput["headers"]): string | null {
  const contentTypes = headerValues(headers, "content-type");
  if (contentTypes.length !== 1) return null;
  const [value] = (contentTypes[0] as string).split(";", 1);
  return value?.trim().toLowerCase() ?? null;
}

function hasAllowedContentType(input: RequestSecurityInput): boolean {
  const type = mediaType(input.headers);
  if (type === "application/json") return true;
  const path = input.url?.split("?", 1)[0];
  return (
    input.method === "POST" &&
    (path === "/api/v2/photos" || path === "/api/v2/delivery-evidence/attachments") &&
    (type === "image/jpeg" || type === "image/png" || type === "image/webp")
  );
}

export function evaluateLocalRequest(
  input: RequestSecurityInput,
  policy: LocalRequestSecurityPolicy,
): RequestSecurityDecision {
  if (hasUntrustedSourceMetadata(input.headers) || !hasAllowedHost(input.headers, policy)) {
    return BAD_REQUEST;
  }
  if (SAFE_METHODS.includes(input.method as (typeof SAFE_METHODS)[number])) return ALLOWED;
  if (!hasAllowedOriginPair(input.headers, policy)) return FORBIDDEN;
  if (!hasAllowedContentType(input)) return UNSUPPORTED_MEDIA_TYPE;
  return ALLOWED;
}

export function registerRequestSecurityHooks(
  app: FastifyInstance,
  options: LocalRequestSecurityOptions,
): LocalRequestSecurityPolicy {
  const policy = createRequestSecurityPolicy(options);
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.split("?", 1)[0]?.startsWith("/api/v2/customer/auth/") === true) {
      reply.header("Cache-Control", "no-store");
    }
    const decision = evaluateLocalRequest(
      Object.freeze({ method: request.method, url: request.url, headers: request.headers }),
      policy,
    );
    const trustedSource = proxyClientIp(request.headers, request.ip);
    if (!decision.allowed || trustedSource === null) {
      await reply.code(decision.allowed ? 400 : decision.statusCode).send(PUBLIC_FAILURE);
    }
  });
  return policy;
}
