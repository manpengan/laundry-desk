/**
 * R3 confirmation over HTTP.
 *
 * A policy-gated command answers the first call with a confirm_ref, and the
 * direct-args client replies with a bare `{ confirm_ref }` body. That body
 * carries none of the branded envelope keys, so it used to fall through to the
 * raw-args path and get validated against the command schema — every R3
 * confirmation was unfinishable from the browser. Server-side tests missed it
 * because they call executeCommand directly with the confirmRef option and
 * never cross the route.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";
import { resolveCookiePolicy } from "./cookie-policy.js";
import { createLocalApp } from "./create-app.js";

const DEVICE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const localCookies = resolveCookiePolicy({ secure: false });
const browserHeaders = Object.freeze({
  host: "127.0.0.1:8787",
  origin: "http://127.0.0.1:5173",
  "sec-fetch-site": "same-site",
});

async function buildApp() {
  const runtime = await createMemoryLocalRuntime();
  const app = await createLocalApp({ runtime, cookiePolicy: localCookies, logger: false });
  return app;
}

function readCookies(headers: Record<string, unknown>): string {
  const raw = headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.map((line) => String(line).split(";")[0]).join("; ");
}

test("a bare confirm_ref body is treated as a confirmation, not as command args", async () => {
  const app = await buildApp();
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/v2/auth/login",
      headers: browserHeaders,
      payload: {
        org_code: "local",
        store_code: "main",
        username: "admin",
        password: DEMO_PASSWORD,
        device_id: DEVICE,
      },
    });
    assert.equal(login.statusCode, 200);
    const token = (login.json() as { data: { access_token: string } }).data.access_token;
    const cookies = readCookies(login.headers as Record<string, unknown>);
    const csrf = /(?:__Host-)?laundry_csrf=([^;]+)/u.exec(cookies)?.[1] ?? "";

    const commandHeaders = {
      ...browserHeaders,
      authorization: `Bearer ${token}`,
      cookie: cookies,
      "x-csrf-token": csrf,
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/commands/platform.settings.set",
      headers: commandHeaders,
      payload: { entries: [{ key: "pricing.min_order_cents", value_json: "1200" }] },
    });
    const firstBody = first.json() as {
      ok: boolean;
      error?: { code?: string; detail?: { confirm_ref?: string } };
    };
    assert.equal(firstBody.ok, false, "a policy-gated command must not execute on the first call");
    const confirmRef = firstBody.error?.detail?.confirm_ref;
    assert.equal(typeof confirmRef, "string", `expected a confirm_ref, got ${first.body}`);

    // The reply the browser actually sends. Before the fix this failed schema
    // validation on the command's own required fields.
    const second = await app.inject({
      method: "POST",
      url: "/v1/commands/platform.settings.set",
      headers: commandHeaders,
      payload: { confirm_ref: confirmRef },
    });
    const secondBody = second.json() as { ok: boolean; error?: { code?: string } };
    assert.notEqual(
      secondBody.error?.code,
      "VALIDATION_FAILED",
      "a confirmation must never be validated as command args",
    );
  } finally {
    await app.close();
  }
});

test("a confirm_ref alongside other keys stays on the raw-args path", async () => {
  const app = await buildApp();
  try {
    const login = await app.inject({
      method: "POST",
      url: "/api/v2/auth/login",
      headers: browserHeaders,
      payload: {
        org_code: "local",
        store_code: "main",
        username: "admin",
        password: DEMO_PASSWORD,
        device_id: DEVICE,
      },
    });
    const token = (login.json() as { data: { access_token: string } }).data.access_token;
    const cookies = readCookies(login.headers as Record<string, unknown>);
    const csrf = /(?:__Host-)?laundry_csrf=([^;]+)/u.exec(cookies)?.[1] ?? "";

    // Only an exactly-one-key body is a confirmation; anything richer must not
    // be able to smuggle a confirmation past argument validation.
    const response = await app.inject({
      method: "POST",
      url: "/v1/commands/platform.settings.set",
      headers: {
        ...browserHeaders,
        authorization: `Bearer ${token}`,
        cookie: cookies,
        "x-csrf-token": csrf,
      },
      payload: { confirm_ref: "11111111-1111-4111-8111-111111111111", entries: [] },
    });
    const body = response.json() as { ok: boolean; error?: { code?: string } };
    assert.equal(body.ok, false);
    assert.equal(body.error?.code, "VALIDATION_FAILED");
  } finally {
    await app.close();
  }
});
