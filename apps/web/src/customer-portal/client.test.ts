import assert from "node:assert/strict";
import test from "node:test";

import { CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME } from "@laundry/contracts";

import type { CustomerPortalAuthorityStore } from "./authority.js";
import { createHttpCustomerPortalClient } from "./client.js";

const ORDER = "11111111-1111-4111-8111-111111111111";
const AUTHORITY = `v1.${"a".repeat(43)}`;
const SUMMARY = Object.freeze({
  order_id: ORDER,
  ticket_no: "20260813-0001",
  status: "open",
  payable_cents: 2_000,
  paid_cents: 1_000,
  balance_cents: 1_000,
  garment_count: 1,
  created_at: "2026-08-13T01:00:00.000Z",
  updated_at: "2026-08-13T01:10:00.000Z",
});

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function authorityStore(initial: string | null = AUTHORITY): CustomerPortalAuthorityStore {
  let value = initial;
  return Object.freeze({
    claimCurrent: async () => value,
    current: () => value,
    issue: async () => {
      value = AUTHORITY;
      return value;
    },
    clear: (expected: string) => {
      if (value === expected) value = null;
    },
    dispose: () => undefined,
  });
}

test("customer portal client sends cookie auth plus CSRF without a bearer token", async () => {
  const calls: Array<Readonly<{ url: string; init: RequestInit | undefined }>> = [];
  let csrfSelector: string | null = null;
  const client = createHttpCustomerPortalClient({
    apiBaseUrl: "https://desk.example",
    readCsrf: (authority) => {
      csrfSelector = authority;
      return "v1.safe-csrf";
    },
    authorityStore: authorityStore(),
    fetchImpl: async (url, init) => {
      calls.push(Object.freeze({ url: String(url), init }));
      return response({ ok: true, data: { execution: "executed", result: { orders: [SUMMARY] } } });
    },
  });
  const controller = new AbortController();
  const result = await client.listOrders(10, controller.signal);
  assert.equal(result.ok, true);
  assert.equal(calls[0]?.url, "https://desk.example/v1/queries/customer.self_service.orders.list");
  assert.equal(calls[0]?.init?.credentials, "include");
  assert.equal(calls[0]?.init?.signal, controller.signal);
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers["x-csrf-token"], "v1.safe-csrf");
  assert.equal(headers[CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME], AUTHORITY);
  assert.equal(csrfSelector, AUTHORITY);
  assert.equal(headers.authorization, undefined);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { limit: 10 });
});

test("customer portal client validates login before sending secrets", async () => {
  let calls = 0;
  const client = createHttpCustomerPortalClient({
    apiBaseUrl: "",
    authorityStore: authorityStore(),
    fetchImpl: async () => {
      calls += 1;
      return response({});
    },
  });
  const result = await client.login({
    org_code: "local",
    store_code: "main",
    phone: "not-a-phone",
    pickup_code: "PK01",
  });
  assert.deepEqual(result, {
    ok: false,
    error: { code: "VALIDATION_FAILED", message: "请检查手机号和取件码" },
  });
  assert.equal(calls, 0);
});

test("customer portal client rejects over-broad response objects", async () => {
  const client = createHttpCustomerPortalClient({
    apiBaseUrl: "",
    readCsrf: () => "v1.safe-csrf",
    authorityStore: authorityStore(),
    fetchImpl: async () =>
      response({
        ok: true,
        data: {
          execution: "executed",
          result: { orders: [{ ...SUMMARY, internal_note: "never expose" }] },
        },
      }),
  });
  assert.deepEqual(await client.listOrders(), {
    ok: false,
    error: { code: "INVALID_RESPONSE", message: "查询响应格式异常" },
  });
});

test("customer portal client requires readable CSRF before every POST query", async () => {
  let calls = 0;
  const client = createHttpCustomerPortalClient({
    apiBaseUrl: "",
    readCsrf: () => null,
    authorityStore: authorityStore(),
    fetchImpl: async () => {
      calls += 1;
      return response({});
    },
  });
  const result = await client.getOrder(ORDER);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "CSRF_REJECTED");
  assert.equal(calls, 0);
});

test("logout invalidates tab authority before the network request while sending the captured proof", async () => {
  const store = authorityStore();
  const client = createHttpCustomerPortalClient({
    apiBaseUrl: "",
    readCsrf: () => "v1.safe-csrf",
    authorityStore: store,
    fetchImpl: async (_url, init) => {
      assert.equal(store.current(), null);
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers[CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME], AUTHORITY);
      return response({ ok: true, data: { logged_out: true } });
    },
  });
  assert.equal((await client.logout()).ok, true);
  assert.equal(store.current(), null);
});

test("an ignored old login failure cannot clear a newer tab authority", async () => {
  const AUTHORITY_B = `v1.${"b".repeat(43)}`;
  let current: string | null = null;
  let issues = 0;
  const store: CustomerPortalAuthorityStore = Object.freeze({
    claimCurrent: async () => current,
    current: () => current,
    issue: async () => {
      issues += 1;
      current = issues === 1 ? AUTHORITY : AUTHORITY_B;
      return current;
    },
    clear: (expected: string) => {
      if (current === expected) current = null;
    },
    dispose: () => undefined,
  });
  const resolvers: Array<(value: Response) => void> = [];
  const client = createHttpCustomerPortalClient({
    apiBaseUrl: "",
    authorityStore: store,
    fetchImpl: async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      return new Promise<Response>((resolve) => {
        resolvers[headers[CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME] === AUTHORITY ? 0 : 1] = resolve;
      });
    },
  });
  const input = {
    org_code: "local",
    store_code: "main",
    phone: "13800000001",
    pickup_code: "PK0001",
  } as const;
  const oldLogin = client.login(input);
  const newLogin = client.login({ ...input, phone: "13900000002" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const finishOld = resolvers[0];
  const finishNew = resolvers[1];
  assert.ok(finishOld);
  assert.ok(finishNew);
  finishOld(response({ ok: false, error: { code: "AUTHENTICATION_FAILED", message: "no" } }));
  assert.equal((await oldLogin).ok, false);
  assert.equal(store.current(), AUTHORITY_B);
  finishNew(response({ ok: true, data: { authenticated: true, expires_at: 1_800_000_000 } }));
  assert.equal((await newLogin).ok, true);
  assert.equal(store.current(), AUTHORITY_B);
});
