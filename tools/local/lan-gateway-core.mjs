import { request as requestHttp } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const MAXIMUM_ASSET_FILES = 512;
const MAXIMUM_ASSET_BYTES = 32 * 1024 * 1024;
const MAXIMUM_REQUEST_BYTES = 1024 * 1024;
const MAXIMUM_RESPONSE_BYTES = 4 * 1024 * 1024;
const BACKEND_TIMEOUT_MS = 10_000;
const STATIC_INDEX_ROUTE = "/owner";
const STATIC_INDEX_REDIRECT_ROUTE = "/owner/";
export const LAN_GATEWAY_PROXY_ROUTES = Object.freeze([
  "GET /health",
  "GET /api/v2/local/staff",
  "POST /api/v2/auth/login",
  "POST /api/v2/auth/logout",
  "POST /v1/queries/reporting.owner_dashboard.get",
  "POST /v1/queries/reporting.owner_dashboard.drilldown",
  "POST /v1/queries/reporting.owner_portfolio.get",
]);
const PROXY_ROUTES = new Set(LAN_GATEWAY_PROXY_ROUTES);
const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "authorization",
  "content-type",
  "cookie",
  "origin",
  "sec-fetch-site",
  "user-agent",
  "x-csrf-token",
]);
const FORWARDED_RESPONSE_HEADERS = new Set([
  "access-control-allow-credentials",
  "access-control-allow-origin",
  "content-type",
  "set-cookie",
  "vary",
]);

const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

const CONTENT_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
});

function hashStaticAssets(rows) {
  const hash = createHash("sha256");
  hash.update("laundry-owner-spa:v1\0");
  for (const [path, asset] of rows) {
    const fileHash = createHash("sha256").update(asset.body).digest("hex");
    hash.update(path);
    hash.update("\0");
    hash.update(String(asset.body.byteLength));
    hash.update("\0");
    hash.update(fileHash);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function headerValues(headers, expectedName) {
  return Object.entries(headers).flatMap(([name, value]) => {
    if (name.toLowerCase() !== expectedName || value === undefined) return [];
    return Array.isArray(value) ? value : [value];
  });
}

function hasForwardingMetadata(headers) {
  return Object.entries(headers).some(([name, value]) => {
    if (value === undefined) return false;
    const normalized = name.toLowerCase();
    return normalized === "forwarded" || normalized.startsWith("x-forwarded-");
  });
}

function parseRequestPath(rawUrl, origin) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("/")) return null;
  try {
    const parsed = new URL(rawUrl, origin);
    if (parsed.origin !== origin || parsed.search !== "" || parsed.hash !== "") return null;
    return parsed.pathname;
  } catch {
    return null;
  }
}

function hasJsonContentType(headers) {
  const values = headerValues(headers, "content-type");
  if (values.length !== 1 || typeof values[0] !== "string") return false;
  return values[0].split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

export function classifyLanGatewayRequest(input, config, assets) {
  if (
    hasForwardingMetadata(input.headers) ||
    headerValues(input.headers, "host").length !== 1 ||
    headerValues(input.headers, "host")[0] !== config.authority
  ) {
    return Object.freeze({ kind: "reject", statusCode: 400 });
  }
  const path = parseRequestPath(input.url, config.origin);
  if (path === null) return Object.freeze({ kind: "reject", statusCode: 400 });

  if (input.method === "GET" || input.method === "HEAD") {
    if (path === STATIC_INDEX_REDIRECT_ROUTE) {
      return Object.freeze({ kind: "redirect" });
    }
    if (path === STATIC_INDEX_ROUTE) {
      return Object.freeze({ kind: "static", path: "/index.html" });
    }
    if (path !== "/index.html" && assets.has(path)) {
      return Object.freeze({ kind: "static", path });
    }
    if (input.method === "GET" && PROXY_ROUTES.has(`GET ${path}`)) {
      return Object.freeze({ kind: "proxy", path });
    }
    return Object.freeze({ kind: "reject", statusCode: 404 });
  }

  if (input.method !== "POST" || !PROXY_ROUTES.has(`POST ${path}`)) {
    return Object.freeze({ kind: "reject", statusCode: 404 });
  }
  const origins = headerValues(input.headers, "origin");
  const fetchSites = headerValues(input.headers, "sec-fetch-site");
  if (
    origins.length !== 1 ||
    origins[0] !== config.origin ||
    fetchSites.length !== 1 ||
    fetchSites[0] !== "same-origin"
  ) {
    return Object.freeze({ kind: "reject", statusCode: 403 });
  }
  if (!hasJsonContentType(input.headers)) {
    return Object.freeze({ kind: "reject", statusCode: 415 });
  }
  return Object.freeze({ kind: "proxy", path });
}

function extension(path) {
  const index = path.lastIndexOf(".");
  return index < 0 ? "" : path.slice(index);
}

async function listAssetFiles(root, directory = root) {
  const entries = (await readdir(directory, { withFileTypes: true })).toSorted((left, right) =>
    left.name.localeCompare(right.name),
  );
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error("LAN_STATIC_SYMLINK_FORBIDDEN");
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listAssetFiles(root, path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error("LAN_STATIC_FILE_TYPE_FORBIDDEN");
  }
  return files;
}

async function readBoundedAsset(filePath, maximumBytes) {
  const handle = await open(filePath, fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("LAN_STATIC_FILE_TYPE_FORBIDDEN");
    if (metadata.size > maximumBytes) throw new Error("LAN_STATIC_BYTES_EXCEEDED");
    const chunks = [];
    let total = 0;
    while (total <= maximumBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumBytes) throw new Error("LAN_STATIC_BYTES_EXCEEDED");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

export async function loadLanStaticAssets(webRoot, expectedSha256 = undefined) {
  const files = await listAssetFiles(webRoot);
  if (files.length === 0 || files.length > MAXIMUM_ASSET_FILES) {
    throw new Error("LAN_STATIC_FILE_COUNT_INVALID");
  }
  const rows = [];
  let totalBytes = 0;
  for (const filePath of files) {
    const relativePath = relative(webRoot, filePath);
    if (relativePath.startsWith("..") || relativePath.includes(`..${sep}`)) {
      throw new Error("LAN_STATIC_PATH_INVALID");
    }
    const body = await readBoundedAsset(filePath, MAXIMUM_ASSET_BYTES - totalBytes);
    totalBytes += body.byteLength;
    const urlPath = `/${relativePath.split(sep).map(encodeURIComponent).join("/")}`;
    const contentType = CONTENT_TYPES[extension(urlPath)];
    if (contentType === undefined) throw new Error("LAN_STATIC_CONTENT_TYPE_FORBIDDEN");
    rows.push([urlPath, Object.freeze({ body, contentType })]);
  }
  const index = rows.find(([path]) => path === "/index.html");
  if (index === undefined) throw new Error("LAN_STATIC_INDEX_MISSING");
  const sha256 = hashStaticAssets(rows);
  if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
    throw new Error("LAN_STATIC_INTEGRITY_MISMATCH");
  }
  const assets = new Map(rows);
  return Object.freeze({
    has: (path) => assets.has(path),
    get: (path) => assets.get(path) ?? null,
    paths: Object.freeze([...assets.keys()]),
    sha256,
  });
}

async function collectBody(stream, maximumBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maximumBytes) throw new Error("LAN_GATEWAY_BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function forwardedHeaders(headers, backendAuthority, bodyLength) {
  const output = { host: backendAuthority, connection: "close" };
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && FORWARDED_REQUEST_HEADERS.has(name.toLowerCase())) {
      output[name.toLowerCase()] = value;
    }
  }
  if (bodyLength > 0) output["content-length"] = String(bodyLength);
  return output;
}

async function callBackend(request, decision, config, httpRequest) {
  const body = request.method === "POST" ? await collectBody(request, MAXIMUM_REQUEST_BYTES) : null;
  return await new Promise((resolve, reject) => {
    const upstream = httpRequest(
      {
        host: config.backendHost,
        port: config.backendPort,
        method: request.method,
        path: decision.path,
        headers: forwardedHeaders(
          request.headers,
          `${config.backendHost}:${config.backendPort}`,
          body?.byteLength ?? 0,
        ),
      },
      async (response) => {
        try {
          const responseBody = await collectBody(response, MAXIMUM_RESPONSE_BYTES);
          resolve({
            statusCode: response.statusCode ?? 502,
            headers: response.headers,
            responseBody,
          });
        } catch (error) {
          reject(error);
        }
      },
    );
    upstream.setTimeout(BACKEND_TIMEOUT_MS, () =>
      upstream.destroy(new Error("LAN_BACKEND_TIMEOUT")),
    );
    upstream.once("error", reject);
    upstream.end(body ?? undefined);
  });
}

function applySecurityHeaders(response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
}

function sendFailure(response, statusCode) {
  applySecurityHeaders(response);
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end('{"ok":false,"error":{"code":"REQUEST_REJECTED"}}');
}

function sendStatic(request, response, asset) {
  applySecurityHeaders(response);
  response.statusCode = 200;
  response.setHeader("content-type", asset.contentType);
  response.setHeader("content-length", String(asset.body.byteLength));
  response.end(request.method === "HEAD" ? undefined : asset.body);
}

function sendOwnerRedirect(response) {
  applySecurityHeaders(response);
  response.statusCode = 308;
  response.setHeader("location", STATIC_INDEX_ROUTE);
  response.setHeader("content-length", "0");
  response.end();
}

function sendBackend(response, result) {
  applySecurityHeaders(response);
  response.statusCode = result.statusCode;
  for (const [name, value] of Object.entries(result.headers)) {
    if (value !== undefined && FORWARDED_RESPONSE_HEADERS.has(name.toLowerCase())) {
      response.setHeader(name, value);
    }
  }
  response.setHeader("content-length", String(result.responseBody.byteLength));
  response.end(result.responseBody);
}

export function createLanGateway(config, assets, dependencies = {}) {
  const httpsServer = dependencies.createHttpsServer ?? createHttpsServer;
  const httpRequest = dependencies.httpRequest ?? requestHttp;
  const server = httpsServer(
    { cert: config.cert, key: config.key, minVersion: "TLSv1.2" },
    async (request, response) => {
      const decision = classifyLanGatewayRequest(
        { method: request.method ?? "", url: request.url, headers: request.headers },
        config,
        assets,
      );
      if (decision.kind === "reject") {
        sendFailure(response, decision.statusCode);
        return;
      }
      if (decision.kind === "static") {
        const asset = assets.get(decision.path);
        if (asset === null) sendFailure(response, 404);
        else sendStatic(request, response, asset);
        return;
      }
      if (decision.kind === "redirect") {
        sendOwnerRedirect(response);
        return;
      }
      try {
        sendBackend(response, await callBackend(request, decision, config, httpRequest));
      } catch {
        if (!response.headersSent) sendFailure(response, 502);
        else response.destroy();
      }
    },
  );
  server.maxHeadersCount = 64;
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
