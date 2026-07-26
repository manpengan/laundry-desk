import {
  DESKTOP_API_BASE_URL,
  DESKTOP_REQUEST_ORIGIN,
  type DesktopHttpRequest,
  type DesktopHttpResponse,
  type DesktopHttpTransportDependencies,
} from "./http-transport.js";

export const DESKTOP_MAX_RESPONSE_BYTES = 512 * 1_024;
const DESKTOP_MAX_REQUEST_BYTES = 256 * 1_024;
const DESKTOP_REQUEST_TIMEOUT_MS = 15_000;
const CSRF_COOKIE_NAMES = new Set(["laundry_csrf", "__Host-laundry_csrf"]);
const AUTH_COOKIE_NAMES = new Set([
  "laundry_csrf",
  "__Host-laundry_csrf",
  "laundry_refresh",
  "__Host-laundry_refresh",
]);
const ALLOWED_HEADER_NAMES = new Set([
  "origin",
  "sec-fetch-site",
  "content-type",
  "authorization",
  "x-csrf-token",
]);
const API_URL = new URL(DESKTOP_API_BASE_URL);

export type ElectronCookieSurface = Readonly<{
  name: string;
  value: string;
  secure?: boolean;
  domain?: string;
  path?: string;
}>;

type ElectronCookieStoreSurface = Readonly<{
  get: (filter: Readonly<Record<string, unknown>>) => Promise<readonly ElectronCookieSurface[]>;
  remove: (url: string, name: string) => Promise<void>;
  flushStore: () => Promise<void>;
}>;

export type ElectronSessionSurface = Readonly<{
  cookies: ElectronCookieStoreSurface;
}>;

type ElectronIncomingMessageSurface = Readonly<{
  statusCode: number;
  on: {
    (event: "data", listener: (chunk: Buffer | Uint8Array | string) => void): unknown;
    (event: "end", listener: () => void): unknown;
    (event: "error", listener: (error: Error) => void): unknown;
  };
}>;

type ElectronClientRequestSurface = Readonly<{
  once: {
    (event: "response", listener: (response: ElectronIncomingMessageSurface) => void): unknown;
    (event: "error", listener: (error: Error) => void): unknown;
  };
  write: (body: string) => void;
  end: () => void;
  abort: () => void;
}>;

export type ElectronNetRequestOptions = Readonly<{
  method: "GET" | "POST";
  url: string;
  headers: Readonly<Record<string, string>>;
  session: ElectronSessionSurface;
  credentials: "include";
  redirect: "error";
  origin: typeof DESKTOP_REQUEST_ORIGIN;
}>;

type ElectronNetSurface = Readonly<{
  request: (options: ElectronNetRequestOptions) => ElectronClientRequestSurface;
}>;

export type ElectronDesktopDependencyOptions = Readonly<{
  net: ElectronNetSurface;
  session: ElectronSessionSurface;
  deviceId: string;
}>;

function assertFixedRequestPolicy(request: DesktopHttpRequest): void {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new Error("Request violates the fixed desktop HTTP policy");
  }
  const headerNames = Object.keys(request.headers);
  const normalizedHeaderNames = headerNames.map((name) => name.toLowerCase());
  const hasForbiddenHeader = headerNames.some((name) => {
    const normalized = name.toLowerCase();
    return (
      normalized === "forwarded" ||
      normalized.startsWith("x-forwarded-") ||
      !ALLOWED_HEADER_NAMES.has(normalized)
    );
  });
  const hasUnsafeHeaderValue = Object.values(request.headers).some((value) =>
    /[\r\n]/u.test(value),
  );
  const isPost = request.method === "POST";
  if (
    request.credentials !== "include" ||
    request.redirect !== "error" ||
    request.origin !== DESKTOP_REQUEST_ORIGIN ||
    request.headers.Origin !== DESKTOP_REQUEST_ORIGIN ||
    request.headers["Sec-Fetch-Site"] !== "same-origin" ||
    hasForbiddenHeader ||
    hasUnsafeHeaderValue ||
    new Set(normalizedHeaderNames).size !== headerNames.length ||
    url.origin !== API_URL.origin ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.href !== request.url ||
    (request.method !== "GET" && !isPost) ||
    (isPost && request.headers["Content-Type"] !== "application/json") ||
    (isPost && request.body === undefined) ||
    (request.body !== undefined &&
      Buffer.byteLength(request.body, "utf8") > DESKTOP_MAX_REQUEST_BYTES) ||
    (!isPost && request.body !== undefined)
  ) {
    throw new Error("Request violates the fixed desktop HTTP policy");
  }
}

function normalizeChunk(chunk: Buffer | Uint8Array | string): Buffer {
  if (typeof chunk === "string") return Buffer.from(chunk);
  return Buffer.from(chunk);
}

async function executeRequest(
  net: ElectronNetSurface,
  session: ElectronSessionSurface,
  request: DesktopHttpRequest,
): Promise<DesktopHttpResponse> {
  assertFixedRequestPolicy(request);

  return new Promise<DesktopHttpResponse>((resolve, reject) => {
    let settled = false;
    let clientRequest: ElectronClientRequestSurface;
    try {
      clientRequest = net.request({
        method: request.method,
        url: request.url,
        headers: request.headers,
        session,
        credentials: "include",
        redirect: "error",
        origin: DESKTOP_REQUEST_ORIGIN,
      });
    } catch (error) {
      reject(error);
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clientRequest.abort();
      reject(new Error("Desktop HTTP request timed out"));
    }, DESKTOP_REQUEST_TIMEOUT_MS);
    timer.unref();

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    clientRequest.once("error", fail);
    clientRequest.once("response", (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("error", fail);
      response.on("data", (chunk) => {
        if (settled) return;
        const normalized = normalizeChunk(chunk);
        bytes += normalized.byteLength;
        if (bytes > DESKTOP_MAX_RESPONSE_BYTES) {
          clientRequest.abort();
          fail(new Error("Desktop HTTP response is too large"));
          return;
        }
        chunks.push(normalized);
      });
      response.on("end", () => {
        if (settled) return;
        if (
          !Number.isSafeInteger(response.statusCode) ||
          response.statusCode < 100 ||
          response.statusCode > 599
        ) {
          fail(new Error("Desktop HTTP response has an invalid status"));
          return;
        }
        let bodyText: string;
        try {
          bodyText = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        } catch {
          fail(new Error("Desktop HTTP response is not valid UTF-8"));
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(Object.freeze({ statusCode: response.statusCode, bodyText }));
      });
    });

    try {
      if (request.body !== undefined) clientRequest.write(request.body);
      clientRequest.end();
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Desktop HTTP request failed"));
    }
  });
}

function belongsToFixedHost(cookie: ElectronCookieSurface): boolean {
  const domain = cookie.domain?.replace(/^\./u, "");
  return domain === undefined || domain === API_URL.hostname;
}

async function readCsrfCookies(
  cookies: ElectronCookieStoreSurface,
  url: string,
): Promise<readonly Readonly<{ name: string; value: string }>[]> {
  if (url !== DESKTOP_API_BASE_URL) {
    throw new Error("Cookie access violates the fixed desktop HTTP policy");
  }
  const all = await cookies.get({ domain: API_URL.hostname });
  const selected = all.filter(
    (cookie) => belongsToFixedHost(cookie) && CSRF_COOKIE_NAMES.has(cookie.name),
  );
  const names = new Set<string>();
  for (const cookie of selected) {
    if (names.has(cookie.name)) {
      throw new Error(`Ambiguous desktop cookie: ${cookie.name}`);
    }
    names.add(cookie.name);
  }
  return Object.freeze(
    selected.map((cookie) => Object.freeze({ name: cookie.name, value: cookie.value })),
  );
}

function removalUrl(cookie: ElectronCookieSurface): string {
  const scheme = cookie.secure === true ? "https:" : API_URL.protocol;
  const path = cookie.path?.startsWith("/") === true ? cookie.path : "/";
  return `${scheme}//${API_URL.host}${path}`;
}

async function clearAuthCookies(cookies: ElectronCookieStoreSurface, url: string): Promise<void> {
  if (url !== DESKTOP_API_BASE_URL) {
    throw new Error("Cookie access violates the fixed desktop HTTP policy");
  }
  const all = await cookies.get({ domain: API_URL.hostname });
  const candidates = all.filter(
    (cookie) => belongsToFixedHost(cookie) && AUTH_COOKIE_NAMES.has(cookie.name),
  );
  const removalResults = await Promise.allSettled(
    candidates.map((cookie) => cookies.remove(removalUrl(cookie), cookie.name)),
  );
  let flushError: unknown;
  try {
    await cookies.flushStore();
  } catch (error) {
    flushError = error;
  }
  const failures = removalResults.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (flushError !== undefined) failures.push(flushError);
  if (failures.length > 0) {
    throw new AggregateError(failures, "Desktop auth cookie cleanup failed");
  }
}

/** Adapt Electron net.request and the dedicated session cookie jar to the fixed transport. */
export function createElectronDesktopDependencies(
  options: ElectronDesktopDependencyOptions,
): DesktopHttpTransportDependencies {
  return Object.freeze({
    request: (request) => executeRequest(options.net, options.session, request),
    cookies: Object.freeze({
      get: (url: string) => readCsrfCookies(options.session.cookies, url),
      clear: (url: string) => clearAuthCookies(options.session.cookies, url),
    }),
    deviceId: options.deviceId,
  });
}
