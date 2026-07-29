import assert from "node:assert/strict";
import test from "node:test";

import {
  createDesktopHttpTransport,
  DESKTOP_API_BASE_URL,
  DESKTOP_REQUEST_ORIGIN,
  type DesktopHttpRequest,
  type DesktopHttpResponse,
  type DesktopHttpTransportDependencies,
} from "./http-transport.js";

const DEVICE_ID = "00000000-0000-4000-8000-000000000001";
const SESSION_ID = "00000000-0000-4000-8000-000000000002";
const ORG_ID = "00000000-0000-4000-8000-000000000003";
const STORE_ID = "00000000-0000-4000-8000-000000000004";
const ADMIN_ID = "00000000-0000-4000-8000-000000000005";
const ORDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GARMENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PHOTO_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ACCESS_TOKEN = "header.payload.signature";
const CSRF_TOKEN = `v1.${"a".repeat(43)}`;
const LOGIN_INPUT = Object.freeze({
  org_code: "demo-org",
  store_code: "demo-store",
  username: "admin",
  password: "password",
});

function jsonResponse(payload: unknown): DesktopHttpResponse {
  return Object.freeze({ statusCode: 200, bodyText: JSON.stringify(payload) });
}

function authenticatedSession(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    access_token: ACCESS_TOKEN,
    token_type: "Bearer",
    expires_in: 900,
    storage: "memory_only",
    session: Object.freeze({
      session_id: SESSION_ID,
      session_version: 1,
      org_id: ORG_ID,
      store_id: STORE_ID,
      staff_id: ADMIN_ID,
      device_id: DEVICE_ID,
      permission_version: 1,
    }),
    role: "admin",
    features: Object.freeze({ pin_quick_switch: true }),
    display: Object.freeze({
      store_name: "Demo Store",
      staff_name: "Admin",
      org_code: "demo-org",
      store_code: "demo-store",
    }),
  });
}

async function createHarness(photoResponse?: DesktopHttpResponse) {
  let requests: readonly DesktopHttpRequest[] = [];
  let responses = [
    jsonResponse({ ok: true, data: authenticatedSession() }),
    jsonResponse({ ok: true, data: [] }),
    ...(photoResponse === undefined ? [] : [photoResponse]),
  ];
  const dependencies = Object.freeze({
    async request(request: DesktopHttpRequest) {
      requests = Object.freeze([...requests, request]);
      const [next, ...remaining] = responses;
      responses = remaining;
      if (next === undefined) throw new Error("Unexpected HTTP request");
      return next;
    },
    cookies: Object.freeze({
      async get() {
        return Object.freeze([{ name: "laundry_csrf", value: CSRF_TOKEN }]);
      },
      async clear() {},
    }),
    deviceId: DEVICE_ID,
  }) satisfies DesktopHttpTransportDependencies;
  const transport = createDesktopHttpTransport(dependencies);
  assert.equal((await transport.auth.login(LOGIN_INPUT)).ok, true);
  return Object.freeze({
    transport,
    get requests(): readonly DesktopHttpRequest[] {
      return requests;
    },
  });
}

test("named photo upload sends bounded raw bytes on the fixed authenticated route", async () => {
  const harness = await createHarness(
    jsonResponse({
      ok: true,
      data: {
        execution: "executed",
        result: {
          photo_id: PHOTO_ID,
          garment_id: GARMENT_ID,
          order_id: ORDER_ID,
          kind: "receive",
          content_type: "image/jpeg",
          byte_size: 4,
          taken_at: 1_721_606_400,
          created_by_staff_id: ADMIN_ID,
        },
      },
    }),
  );
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const result = await harness.transport.photo.upload({
    order_id: ORDER_ID,
    garment_id: GARMENT_ID,
    kind: "receive",
    content_type: "image/jpeg",
    bytes,
  });

  assert.equal(result.ok, true);
  const request = harness.requests[2]!;
  assert.match(request.url, new RegExp(`^${DESKTOP_API_BASE_URL}/api/v2/photos\\?`, "u"));
  assert.equal(request.credentials, "include");
  assert.equal(request.redirect, "error");
  assert.equal(request.origin, DESKTOP_REQUEST_ORIGIN);
  assert.equal(request.headers.Origin, DESKTOP_REQUEST_ORIGIN);
  assert.equal(request.headers["Sec-Fetch-Site"], "same-origin");
  assert.equal(request.headers["Content-Type"], "image/jpeg");
  assert.equal(request.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(request.headers["X-CSRF-Token"], CSRF_TOKEN);
  assert.ok(request.body instanceof Uint8Array);
  assert.notEqual(request.body, bytes);
  assert.deepEqual(request.body, bytes);
});

test("named photo upload fails closed when private or malformed fields cross IPC", async () => {
  const harness = await createHarness(
    jsonResponse({
      ok: true,
      data: {
        execution: "executed",
        result: {
          photo_id: PHOTO_ID,
          garment_id: GARMENT_ID,
          order_id: ORDER_ID,
          kind: "receive",
          content_type: "image/jpeg",
          byte_size: 4,
          taken_at: 1_721_606_400,
          created_by_staff_id: ADMIN_ID,
          storage_key: "private.jpg",
        },
      },
    }),
  );
  const result = await harness.transport.photo.upload({
    order_id: ORDER_ID,
    garment_id: GARMENT_ID,
    kind: "receive",
    content_type: "image/jpeg",
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "RESOURCE_UNAVAILABLE");
});

test("desktop generic command surface rejects internal photo.register", async () => {
  const harness = await createHarness();
  const result = await harness.transport.command.execute({ name: "photo.register", body: {} });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "VALIDATION_FAILED");
  assert.equal(harness.requests.length, 2);
});
