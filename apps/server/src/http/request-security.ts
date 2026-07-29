import type { FastifyInstance } from "fastify";

import { createCommandError } from "@laundry/contracts";

type HeaderValue = string | readonly string[] | undefined;

export type LocalRequestSecurityOptions = Readonly<{
  allowedHosts: readonly string[];
  browserOrigin: string;
  desktopOrigin: string;
}>;

export type LocalRequestSecurityPolicy = Readonly<{
  allowedHosts: readonly string[];
  browserOrigin: string;
  desktopOrigin: string;
  corsOrigin: string;
}>;

export type RequestSecurityInput = Readonly<{
  method: string;
  url?: string;
  headers: Readonly<Record<string, HeaderValue>>;
}>;

export type RequestSecurityDecision =
  Readonly<{ allowed: true }> | Readonly<{ allowed: false; statusCode: 400 | 403 | 415 }>;

const SAFE_METHODS = Object.freeze(["GET", "HEAD", "OPTIONS"] as const);
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

function hasForwardingMetadata(headers: RequestSecurityInput["headers"]): boolean {
  return Object.entries(headers).some(([name, value]) => {
    if (value === undefined) return false;
    const normalized = name.toLowerCase();
    return normalized === "forwarded" || normalized.startsWith("x-forwarded-");
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
    isExactOrigin(options.desktopOrigin, ["http:", "https:"]) &&
    hosts.includes(desktopHost) &&
    options.browserOrigin !== options.desktopOrigin
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
    desktopOrigin: options.desktopOrigin,
    corsOrigin: options.browserOrigin,
  });
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
    (origins[0] === policy.browserOrigin && fetchSites[0] === "same-site") ||
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
    path === "/api/v2/photos" &&
    (type === "image/jpeg" || type === "image/png" || type === "image/webp")
  );
}

export function evaluateLocalRequest(
  input: RequestSecurityInput,
  policy: LocalRequestSecurityPolicy,
): RequestSecurityDecision {
  if (hasForwardingMetadata(input.headers) || !hasAllowedHost(input.headers, policy)) {
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
    const decision = evaluateLocalRequest(
      Object.freeze({ method: request.method, url: request.url, headers: request.headers }),
      policy,
    );
    if (!decision.allowed) {
      await reply.code(decision.statusCode).send(PUBLIC_FAILURE);
    }
  });
  return policy;
}
