import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  classifyLanGatewayRequest,
  createLanGateway,
  LAN_GATEWAY_PROXY_ROUTES,
  loadLanStaticAssets,
} from "./lan-gateway-core.mjs";

const CONFIG = Object.freeze({
  origin: "https://192.168.50.12:8443",
  authority: "192.168.50.12:8443",
});
const ASSETS = Object.freeze({
  has: (path) => path === "/index.html" || path === "/assets/app.js",
});
const RUNTIME_ASSETS = Object.freeze({
  has: ASSETS.has,
  get: (path) => {
    if (path !== "/index.html" && path !== "/assets/app.js") return null;
    return Object.freeze({
      body: Buffer.from(path === "/index.html" ? "<main>owner</main>" : "export {};"),
      contentType: path === "/index.html" ? "text/html; charset=utf-8" : "text/javascript",
    });
  },
});
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

function request(method, url, headers = {}) {
  return Object.freeze({
    method,
    url,
    headers: Object.freeze({ host: CONFIG.authority, ...headers }),
  });
}

function ownerQuery(headers = {}) {
  return request("POST", "/v1/queries/reporting.owner_dashboard.get", {
    origin: CONFIG.origin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    ...headers,
  });
}

function runtimeRequest(method, url, headers = {}, body = undefined) {
  return Object.assign(
    Readable.from(body === undefined ? [] : [body]),
    request(method, url, headers),
  );
}

function responseRecorder() {
  const headers = new Map();
  const chunks = [];
  return {
    statusCode: 0,
    headersSent: false,
    destroyed: false,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    end(body) {
      this.headersSent = true;
      if (body !== undefined) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(body));
    },
    destroy() {
      this.destroyed = true;
    },
    snapshot() {
      return Object.freeze({
        statusCode: this.statusCode,
        headers: Object.fromEntries(headers),
        body: Buffer.concat(chunks),
        destroyed: this.destroyed,
      });
    },
  };
}

function backendResponse(options = {}) {
  const body = options.body ?? Buffer.from('{"ok":true}');
  const headers = options.headers ?? { "content-type": "application/json" };
  const statusCode = options.statusCode ?? 200;
  return Object.assign(Readable.from([body]), { headers, statusCode });
}

function successfulBackend(onRequest, responseOptions = {}) {
  return (options, callback) => {
    const listeners = new Map();
    return {
      setTimeout(timeout, handler) {
        onRequest?.({ phase: "timeout", timeout });
        listeners.set("timeout", handler);
      },
      once(event, handler) {
        listeners.set(event, handler);
      },
      end(body) {
        onRequest?.({ phase: "request", options, body });
        callback(backendResponse(responseOptions));
      },
      destroy(error) {
        listeners.get("error")?.(error);
      },
    };
  };
}

function failingBackend(mode, onRequest) {
  return (options) => {
    const listeners = new Map();
    let timeoutHandler;
    return {
      setTimeout(timeout, handler) {
        onRequest?.({ phase: "timeout", timeout, options });
        timeoutHandler = handler;
      },
      once(event, handler) {
        listeners.set(event, handler);
      },
      end() {
        if (mode === "timeout") timeoutHandler();
        else listeners.get("error")?.(new Error("LAN_BACKEND_UNAVAILABLE"));
      },
      destroy(error) {
        listeners.get("error")?.(error);
      },
    };
  };
}

function gatewayHandler(httpRequest) {
  let handler;
  const server = {};
  const gateway = createLanGateway(
    {
      ...CONFIG,
      cert: Buffer.from("certificate"),
      key: Buffer.from("private-key"),
      backendHost: "127.0.0.1",
      backendPort: 8787,
    },
    RUNTIME_ASSETS,
    {
      createHttpsServer: (options, requestHandler) => {
        assert.equal(options.minVersion, "TLSv1.2");
        handler = requestHandler;
        return server;
      },
      httpRequest,
    },
  );
  assert.equal(gateway, server);
  assert.equal(typeof handler, "function");
  return handler;
}

async function invokeGateway(handler, input) {
  const response = responseRecorder();
  await handler(input, response);
  return response.snapshot();
}

function assertSecurityHeaders(headers) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(headers[name], value, name);
  }
}

test("serves only the owner SPA routes and immutable asset manifest", () => {
  for (const method of ["GET", "HEAD"]) {
    assert.deepEqual(classifyLanGatewayRequest(request(method, "/owner"), CONFIG, ASSETS), {
      kind: "static",
      path: "/index.html",
    });
    assert.deepEqual(classifyLanGatewayRequest(request(method, "/owner/"), CONFIG, ASSETS), {
      kind: "redirect",
    });
  }
  assert.deepEqual(classifyLanGatewayRequest(request("GET", "/assets/app.js"), CONFIG, ASSETS), {
    kind: "static",
    path: "/assets/app.js",
  });
  for (const method of ["GET", "HEAD"]) {
    for (const path of ["/", "/index.html", "/settings"]) {
      assert.deepEqual(classifyLanGatewayRequest(request(method, path), CONFIG, ASSETS), {
        kind: "reject",
        statusCode: 404,
      });
    }
  }
});

test("redirects the trailing-slash owner route to the fixed canonical path", async () => {
  const handler = gatewayHandler(successfulBackend());
  for (const method of ["GET", "HEAD"]) {
    const response = await invokeGateway(handler, runtimeRequest(method, "/owner/"));
    assert.equal(response.statusCode, 308);
    assert.equal(response.headers.location, "/owner");
    assert.equal(response.headers["content-length"], "0");
    assert.equal(response.body.byteLength, 0);
    assertSecurityHeaders(response.headers);
  }
});

test("proxies only health, staff projection, login/logout, and owner queries", () => {
  assert.deepEqual(LAN_GATEWAY_PROXY_ROUTES, [
    "GET /health",
    "GET /api/v2/local/staff",
    "POST /api/v2/auth/login",
    "POST /api/v2/auth/logout",
    "POST /v1/queries/reporting.owner_dashboard.get",
    "POST /v1/queries/reporting.owner_dashboard.drilldown",
    "POST /v1/queries/reporting.owner_portfolio.get",
  ]);
  for (const [method, path] of [
    ["GET", "/health"],
    ["GET", "/api/v2/local/staff"],
    ["POST", "/api/v2/auth/login"],
    ["POST", "/api/v2/auth/logout"],
    ["POST", "/v1/queries/reporting.owner_dashboard.get"],
    ["POST", "/v1/queries/reporting.owner_dashboard.drilldown"],
    ["POST", "/v1/queries/reporting.owner_portfolio.get"],
  ]) {
    const input =
      method === "POST"
        ? request(method, path, {
            origin: CONFIG.origin,
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
          })
        : request(method, path);
    assert.deepEqual(classifyLanGatewayRequest(input, CONFIG, ASSETS), { kind: "proxy", path });
  }
  for (const path of [
    "/v1/queries/customer.search",
    "/v1/commands/order.receive",
    "/api/v2/auth/pin/challenges",
    "/api/v2/photos",
    "/api/v2/local/diagnostics",
    "/v1/commands/order.receive",
    "/v1/commands/payment.collect",
    "/.well-known/laundry-desk-onboarding",
  ]) {
    assert.deepEqual(classifyLanGatewayRequest(request("POST", path), CONFIG, ASSETS), {
      kind: "reject",
      statusCode: 404,
    });
  }
});

test("rejects wrong Host, forwarding metadata, cross-site pairs, and non-JSON bodies", () => {
  const rejected = [
    request("GET", "/owner", { host: "attacker.invalid" }),
    request("GET", "/owner", { "x-forwarded-host": CONFIG.authority }),
    ownerQuery({ origin: "https://attacker.invalid" }),
    ownerQuery({ "sec-fetch-site": "same-site" }),
    ownerQuery({ "content-type": "text/plain" }),
    ownerQuery({ forwarded: "for=192.168.50.99" }),
    request("POST", "/api/v2/auth/logout", {
      origin: CONFIG.origin,
      "sec-fetch-site": "same-origin",
      "content-type": "text/plain",
    }),
  ];
  for (const input of rejected) {
    assert.equal(classifyLanGatewayRequest(input, CONFIG, ASSETS).kind, "reject");
  }
});

test("rejects query strings and network-path URL confusion", () => {
  for (const url of ["/owner?next=/settings", "//attacker.invalid/owner", "not-a-path"]) {
    assert.deepEqual(classifyLanGatewayRequest(request("GET", url), CONFIG, ASSETS), {
      kind: "reject",
      statusCode: 400,
    });
  }
});

test("loads a fixed startup manifest and requires index.html", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-lan-static-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<main>owner</main>");
  await writeFile(join(root, "assets", "app.js"), "console.log('owner')");
  const assets = await loadLanStaticAssets(root);

  assert.deepEqual(assets.paths, ["/assets/app.js", "/index.html"]);
  assert.equal(assets.get("/index.html").contentType, "text/html; charset=utf-8");
  assert.equal(assets.get("/missing"), null);
  assert.match(assets.sha256, /^[0-9a-f]{64}$/u);

  const missing = await mkdtemp(join(tmpdir(), "laundry-lan-static-missing-"));
  await writeFile(join(missing, "app.js"), "export {};");
  await assert.rejects(() => loadLanStaticAssets(missing), /LAN_STATIC_INDEX_MISSING/u);
});

test("binds the embedded Owner SPA to one deterministic digest and fails closed on drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-lan-static-integrity-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<main>owner</main>");
  await writeFile(join(root, "assets", "app.js"), "export {};\n");

  const first = await loadLanStaticAssets(root);
  const second = await loadLanStaticAssets(root, first.sha256);
  assert.equal(second.sha256, first.sha256);
  assert.notEqual(first.sha256, createHash("sha256").update("<main>owner</main>").digest("hex"));

  await writeFile(join(root, "assets", "app.js"), "export const drift = true;\n");
  await assert.rejects(
    () => loadLanStaticAssets(root, first.sha256),
    /LAN_STATIC_INTEGRITY_MISMATCH/u,
  );
});

test("rejects an oversized sparse asset before buffering its contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-lan-static-oversized-"));
  await writeFile(join(root, "index.html"), "<main>owner</main>");
  const oversizedPath = join(root, "assets.js");
  const handle = await open(oversizedPath, "w");
  try {
    await handle.truncate(32 * 1024 * 1024 + 1);
  } finally {
    await handle.close();
  }

  await assert.rejects(() => loadLanStaticAssets(root), /LAN_STATIC_BYTES_EXCEEDED/u);
});

test("applies the complete security header baseline to static, rejected, and proxied responses", async () => {
  const handler = gatewayHandler(successfulBackend());
  const responses = await Promise.all([
    invokeGateway(handler, runtimeRequest("GET", "/owner")),
    invokeGateway(handler, runtimeRequest("GET", "/owner/")),
    invokeGateway(handler, runtimeRequest("GET", "/settings")),
    invokeGateway(handler, runtimeRequest("GET", "/health")),
  ]);

  assert.deepEqual(
    responses.map((response) => response.statusCode),
    [200, 308, 404, 200],
  );
  for (const response of responses) assertSecurityHeaders(response.headers);
});

test("enforces request and response byte limits at their exact boundaries", async () => {
  let forwardedBodyLength = -1;
  const requestHandler = gatewayHandler(
    successfulBackend((event) => {
      if (event.phase === "request") forwardedBodyLength = event.body.byteLength;
    }),
  );
  const acceptedRequest = await invokeGateway(
    requestHandler,
    runtimeRequest(
      "POST",
      "/api/v2/auth/login",
      {
        origin: CONFIG.origin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      Buffer.alloc(1024 * 1024),
    ),
  );
  assert.equal(acceptedRequest.statusCode, 200);
  assert.equal(forwardedBodyLength, 1024 * 1024);

  let oversizedRequestForwarded = false;
  const oversizedRequestHandler = gatewayHandler(
    successfulBackend(() => {
      oversizedRequestForwarded = true;
    }),
  );
  const oversizedRequest = await invokeGateway(
    oversizedRequestHandler,
    runtimeRequest(
      "POST",
      "/api/v2/auth/login",
      {
        origin: CONFIG.origin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      Buffer.alloc(1024 * 1024 + 1),
    ),
  );
  assert.equal(oversizedRequest.statusCode, 502);
  assert.equal(oversizedRequestForwarded, false);

  const acceptedResponse = await invokeGateway(
    gatewayHandler(successfulBackend(undefined, { body: Buffer.alloc(4 * 1024 * 1024) })),
    runtimeRequest("GET", "/health"),
  );
  assert.equal(acceptedResponse.statusCode, 200);
  assert.equal(acceptedResponse.body.byteLength, 4 * 1024 * 1024);

  const oversizedResponse = await invokeGateway(
    gatewayHandler(successfulBackend(undefined, { body: Buffer.alloc(4 * 1024 * 1024 + 1) })),
    runtimeRequest("GET", "/health"),
  );
  assert.equal(oversizedResponse.statusCode, 502);
  assertSecurityHeaders(oversizedResponse.headers);
});

test("maps backend timeouts and connection errors to a security-hardened 502", async () => {
  for (const mode of ["timeout", "error"]) {
    let configuredTimeout = null;
    const response = await invokeGateway(
      gatewayHandler(
        failingBackend(mode, (event) => {
          if (event.phase === "timeout") configuredTimeout = event.timeout;
        }),
      ),
      runtimeRequest("GET", "/health"),
    );
    assert.equal(configuredTimeout, 10_000);
    assert.equal(response.statusCode, 502);
    assert.match(response.body.toString(), /REQUEST_REJECTED/u);
    assertSecurityHeaders(response.headers);
  }
});

test("never synthesizes or forwards Forwarded and X-Forwarded metadata", async () => {
  let forwardedOptions;
  const handler = gatewayHandler(
    successfulBackend((event) => {
      if (event.phase === "request") forwardedOptions = event.options;
    }),
  );
  const response = await invokeGateway(
    handler,
    runtimeRequest(
      "POST",
      "/v1/queries/reporting.owner_dashboard.get",
      {
        origin: CONFIG.origin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        authorization: "Bearer opaque-test-token",
        "x-untrusted-client-metadata": "discard-me",
      },
      Buffer.from("{}"),
    ),
  );
  assert.equal(response.statusCode, 200);
  assert.equal(forwardedOptions.headers.host, "127.0.0.1:8787");
  assert.equal(forwardedOptions.headers.forwarded, undefined);
  assert.equal(forwardedOptions.headers["x-forwarded-for"], undefined);
  assert.equal(forwardedOptions.headers["x-forwarded-host"], undefined);
  assert.equal(forwardedOptions.headers["x-forwarded-proto"], undefined);
  assert.equal(forwardedOptions.headers["x-untrusted-client-metadata"], undefined);

  let rejectedRequestForwarded = false;
  const rejected = await invokeGateway(
    gatewayHandler(
      successfulBackend(() => {
        rejectedRequestForwarded = true;
      }),
    ),
    runtimeRequest("GET", "/health", { forwarded: "for=192.168.50.99" }),
  );
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejectedRequestForwarded, false);
});
