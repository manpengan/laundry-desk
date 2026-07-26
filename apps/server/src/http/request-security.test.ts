import assert from "node:assert/strict";
import test from "node:test";

import cors from "@fastify/cors";
import Fastify from "fastify";

import {
  createRequestSecurityPolicy,
  evaluateLocalRequest,
  registerRequestSecurityHooks,
  type LocalRequestSecurityOptions,
  type RequestSecurityInput,
} from "./request-security.js";

const BROWSER_ORIGIN = "http://127.0.0.1:5173";
const DESKTOP_ORIGIN = "http://127.0.0.1:8787";
const ALLOWED_HOST = "127.0.0.1:8787";
const OPTIONS = Object.freeze({
  allowedHosts: Object.freeze([ALLOWED_HOST]),
  browserOrigin: BROWSER_ORIGIN,
  desktopOrigin: DESKTOP_ORIGIN,
}) satisfies LocalRequestSecurityOptions;

const POLICY = createRequestSecurityPolicy(OPTIONS);

function request(
  method: string,
  headers: RequestSecurityInput["headers"] = Object.freeze({}),
): RequestSecurityInput {
  return Object.freeze({
    method,
    headers: Object.freeze({
      host: ALLOWED_HOST,
      ...headers,
    }),
  });
}

function browserJsonRequest(
  headers: RequestSecurityInput["headers"] = Object.freeze({}),
): RequestSecurityInput {
  return request(
    "POST",
    Object.freeze({
      origin: BROWSER_ORIGIN,
      "sec-fetch-site": "same-site",
      "content-type": "application/json",
      ...headers,
    }),
  );
}

test("accepts only one exact configured Host authority", () => {
  assert.deepEqual(evaluateLocalRequest(request("GET"), POLICY), { allowed: true });

  for (const host of [
    undefined,
    "localhost:8787",
    "127.0.0.1",
    "127.0.0.1:8788",
    "127.0.0.1:8787.evil.example",
    "127.0.0.1:8787, evil.example",
    ["127.0.0.1:8787", "evil.example"],
  ] as const) {
    const decision = evaluateLocalRequest(
      Object.freeze({
        method: "GET",
        headers: Object.freeze({ host }),
      }),
      POLICY,
    );
    assert.deepEqual(decision, { allowed: false, statusCode: 400 }, String(host));
  }
});

test("rejects Forwarded and every X-Forwarded-* header", () => {
  for (const name of [
    "Forwarded",
    "X-Forwarded-For",
    "X-Forwarded-Host",
    "X-Forwarded-Port",
    "X-Forwarded-Prefix",
    "X-Forwarded-Proto",
  ]) {
    const decision = evaluateLocalRequest(
      request("GET", Object.freeze({ [name]: "untrusted-forwarding-metadata" })),
      POLICY,
    );
    assert.deepEqual(decision, { allowed: false, statusCode: 400 }, name);
  }
});

test("safe public requests need only the Host and forwarding checks", () => {
  const decision = evaluateLocalRequest(
    request(
      "GET",
      Object.freeze({
        origin: "null",
        "sec-fetch-site": "cross-site",
        "content-type": "text/plain",
      }),
    ),
    POLICY,
  );

  assert.deepEqual(decision, { allowed: true });
});

test("accepts only the browser and desktop Origin/Fetch Metadata pairings", () => {
  assert.deepEqual(evaluateLocalRequest(browserJsonRequest(), POLICY), { allowed: true });
  assert.deepEqual(
    evaluateLocalRequest(
      request(
        "POST",
        Object.freeze({
          origin: DESKTOP_ORIGIN,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        }),
      ),
      POLICY,
    ),
    { allowed: true },
  );

  const rejectedPairs = [
    [undefined, "same-site"],
    ["null", "same-site"],
    ["http://localhost:5173", "same-site"],
    ["http://127.0.0.1:5174", "same-site"],
    [BROWSER_ORIGIN, undefined],
    [BROWSER_ORIGIN, "none"],
    [BROWSER_ORIGIN, "same-origin"],
    [BROWSER_ORIGIN, "cross-site"],
    [DESKTOP_ORIGIN, undefined],
    [DESKTOP_ORIGIN, "same-site"],
    [DESKTOP_ORIGIN, "none"],
    [DESKTOP_ORIGIN, "cross-site"],
  ] as const;

  for (const [origin, fetchSite] of rejectedPairs) {
    const decision = evaluateLocalRequest(
      request(
        "POST",
        Object.freeze({
          origin,
          "sec-fetch-site": fetchSite,
          "content-type": "application/json",
        }),
      ),
      POLICY,
    );
    assert.deepEqual(decision, { allowed: false, statusCode: 403 }, String(origin));
  }
});

test("requires application/json for every unsafe request", () => {
  assert.deepEqual(
    evaluateLocalRequest(
      browserJsonRequest(Object.freeze({ "content-type": "application/json; charset=utf-8" })),
      POLICY,
    ),
    { allowed: true },
  );

  for (const contentType of [
    undefined,
    "text/plain",
    "application/x-www-form-urlencoded",
    "multipart/form-data",
    "application/json-patch+json",
  ] as const) {
    const decision = evaluateLocalRequest(
      browserJsonRequest(Object.freeze({ "content-type": contentType })),
      POLICY,
    );
    assert.deepEqual(decision, { allowed: false, statusCode: 415 }, String(contentType));
  }
});

test("policy exposes one static browser CORS origin and rejects unsafe configuration", () => {
  assert.equal(POLICY.corsOrigin, BROWSER_ORIGIN);
  assert.equal(Object.isFrozen(POLICY), true);
  assert.equal(Object.isFrozen(POLICY.allowedHosts), true);
  assert.notEqual(POLICY.corsOrigin, DESKTOP_ORIGIN);
  assert.notEqual(POLICY.corsOrigin, "*");

  const invalidOptions = [
    { ...OPTIONS, allowedHosts: [] },
    { ...OPTIONS, allowedHosts: ["*"] },
    { ...OPTIONS, browserOrigin: "*" },
    { ...OPTIONS, browserOrigin: "null" },
    { ...OPTIONS, desktopOrigin: "*" },
    { ...OPTIONS, desktopOrigin: "app://local" },
    { ...OPTIONS, desktopOrigin: "http://127.0.0.1:8788" },
    { ...OPTIONS, desktopOrigin: "https://attacker.invalid" },
    { ...OPTIONS, desktopOrigin: BROWSER_ORIGIN },
  ] as const;
  for (const options of invalidOptions) {
    assert.throws(
      () => createRequestSecurityPolicy(options),
      /^Error: Invalid local request security configuration$/u,
    );
  }
});

test("Fastify hook protects health and unsafe routes without leaking rejected values", async (t) => {
  const app = Fastify({ logger: false, trustProxy: false });
  const policy = registerRequestSecurityHooks(app, OPTIONS);
  await app.register(cors, {
    origin: policy.corsOrigin,
    credentials: true,
  });
  app.get("/health", async () => ({ ok: true, data: { status: "ready" } }));
  app.post("/unsafe", async () => ({ ok: true, data: { accepted: true } }));
  t.after(async () => app.close());

  const health = await app.inject({
    method: "GET",
    url: "/health",
    headers: { host: ALLOWED_HOST },
  });
  assert.equal(health.statusCode, 200);

  const browser = await app.inject({
    method: "POST",
    url: "/unsafe",
    headers: {
      host: ALLOWED_HOST,
      origin: BROWSER_ORIGIN,
      "sec-fetch-site": "same-site",
      "content-type": "application/json",
    },
    payload: {},
  });
  assert.equal(browser.statusCode, 200);
  assert.equal(browser.headers["access-control-allow-origin"], BROWSER_ORIGIN);

  const desktop = await app.inject({
    method: "POST",
    url: "/unsafe",
    headers: {
      host: ALLOWED_HOST,
      origin: DESKTOP_ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    payload: {},
  });
  assert.equal(desktop.statusCode, 200);
  assert.equal(desktop.headers["access-control-allow-origin"], BROWSER_ORIGIN);
  assert.notEqual(desktop.headers["access-control-allow-origin"], DESKTOP_ORIGIN);

  const sentinel = "private.invalid.example:8787";
  const rejected = await app.inject({
    method: "POST",
    url: "/unsafe",
    headers: {
      host: sentinel,
      origin: BROWSER_ORIGIN,
      "sec-fetch-site": "same-site",
      "content-type": "application/json",
    },
    payload: {},
  });
  assert.equal(rejected.statusCode, 400);
  assert.deepEqual(rejected.json(), {
    ok: false,
    error: {
      code: "VALIDATION_FAILED",
      message: "Request validation failed",
    },
  });
  assert.doesNotMatch(rejected.body, new RegExp(sentinel, "u"));
  assert.notEqual(rejected.headers["access-control-allow-origin"], sentinel);
  assert.notEqual(rejected.headers["access-control-allow-origin"], "*");
});
