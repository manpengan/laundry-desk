import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import {
  CSRF_HEADER_NAME,
  CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME,
  customerPortalCookieNames,
  type CustomerPortalOrderSummary,
} from "@laundry/contracts";

import {
  createCustomerPortalLoginTimingGuard,
  createCustomerPortalQueryRateLimiter,
  type CustomerPortalQueryName,
  type CustomerPortalSessionIdentity,
  type CustomerPortalStore,
} from "../customer-self-service/index.js";
import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";
import { createLocalApp } from "./create-app.js";
import { resolveCookiePolicy } from "./cookie-policy.js";
import { LOCAL_COOKIE_NAMES } from "./types.js";

const ORDER = "11111111-1111-4111-8111-111111111111";
const GARMENT = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const ORG = "44444444-4444-4444-8444-444444444444";
const STORE = "55555555-5555-4555-8555-555555555555";
const CUSTOMER = "66666666-6666-4666-8666-666666666666";
const AUTHORITY = `v1.${"a".repeat(43)}`;
const AUTHORITY_B = `v1.${"b".repeat(43)}`;
const CUSTOMER_B = "77777777-7777-4777-8777-777777777777";
const ORDER_B = "88888888-8888-4888-8888-888888888888";
const GARMENT_B = "99999999-9999-4999-8999-999999999998";
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const cookieSelector = (authority: string): string =>
  createHash("sha256").update(authority, "utf8").digest("base64url");
const browserHeaders = Object.freeze({
  host: "127.0.0.1:8787",
  origin: "http://127.0.0.1:5173",
  "sec-fetch-site": "same-site",
  [CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME]: AUTHORITY,
});
const summary: CustomerPortalOrderSummary = Object.freeze({
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

function cookiesFrom(headers: Readonly<Record<string, unknown>>) {
  const raw = headers["set-cookie"];
  const lines = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return Object.fromEntries(
    lines.map((line) => {
      const pair = line.split(";", 1)[0] ?? "";
      const separator = pair.indexOf("=");
      return [pair.slice(0, separator), pair.slice(separator + 1)];
    }),
  );
}

type FakeOptions = Readonly<{
  authenticate?: boolean;
  unavailableIds?: ReadonlySet<string>;
  resultOverride?: unknown;
}>;

function fakeStore(options: FakeOptions = {}): CustomerPortalStore {
  let active = true;
  let csrfHash = "a".repeat(64);
  let authorityHash = hash(AUTHORITY);
  const identity = (): CustomerPortalSessionIdentity =>
    Object.freeze({
      sessionId: SESSION,
      orgId: ORG,
      storeId: STORE,
      customerId: CUSTOMER,
      csrfHash,
      authorityHash,
      expiresAt: new Date("2026-08-13T01:15:00.000Z"),
    });
  const resultFor = (name: CustomerPortalQueryName) => {
    if (options.resultOverride !== undefined) return options.resultOverride;
    if (name === "customer.self_service.orders.list") return Object.freeze({ orders: [summary] });
    if (name === "customer.self_service.order.get") {
      return Object.freeze({ order: summary, lines: Object.freeze([]) });
    }
    if (name === "customer.self_service.receipt.get") {
      return Object.freeze({
        receipt: Object.freeze({
          order_id: ORDER,
          ticket_no: summary.ticket_no,
          business_date: "2026-08-13",
          original_cents: 2_000,
          discount_cents: 0,
          addon_cents: 0,
          urgent_cents: 0,
          freight_cents: 0,
          payable_cents: 2_000,
          paid_cents: 1_000,
          balance_cents: 1_000,
          created_at: summary.created_at,
          lines: Object.freeze([]),
          payments: Object.freeze([
            Object.freeze({
              payment_id: "99999999-9999-4999-8999-999999999999",
              method: "balance" as const,
              kind: "pay" as const,
              amount_cents: 1_000,
              at: summary.created_at,
            }),
          ]),
        }),
      });
    }
    if (name === "customer.self_service.garments.list") {
      return Object.freeze({
        garments: Object.freeze([
          Object.freeze({
            garment_id: GARMENT,
            order_id: ORDER,
            seq: 1,
            service_code: "wash",
            category_code: "shirt",
            color: null,
            brand: null,
            status: "washing" as const,
          }),
        ]),
      });
    }
    return Object.freeze({
      garment: Object.freeze({
        garment_id: GARMENT,
        order_id: ORDER,
        seq: 1,
        service_code: "wash",
        category_code: "shirt",
        color: null,
        brand: null,
        status: "washing" as const,
      }),
      progress: Object.freeze([
        Object.freeze({
          from_status: "received" as const,
          to_status: "washing" as const,
          at: "2026-08-13T01:10:00.000Z",
        }),
      ]),
    });
  };
  return Object.freeze({
    async createSession(_input, secrets) {
      if (options.authenticate === false) return null;
      csrfHash = secrets.csrfHash;
      authorityHash = secrets.authorityHash;
      active = true;
      return identity();
    },
    async resolveSession() {
      return active ? identity() : null;
    },
    async revokeSession(_sessionHash, requestedCsrfHash, requestedAuthorityHash) {
      if (!active || requestedCsrfHash !== csrfHash || requestedAuthorityHash !== authorityHash) {
        return false;
      }
      active = false;
      return true;
    },
    async executeQuery(_identity, _sessionHash, name, input) {
      const id = typeof input.order_id === "string" ? input.order_id : "";
      if (options.unavailableIds?.has(id) === true) return null;
      return resultFor(name) as never;
    },
  });
}

function raceStore(): CustomerPortalStore {
  type Session = Readonly<{ identity: CustomerPortalSessionIdentity; active: boolean }>;
  let sessions: ReadonlyMap<string, Session> = new Map();
  const summaryFor = (customerId: string): CustomerPortalOrderSummary => {
    const second = customerId === CUSTOMER_B;
    return Object.freeze({
      ...summary,
      order_id: second ? ORDER_B : ORDER,
      ticket_no: second ? "CUSTOMER-B-ONLY" : "CUSTOMER-A-PII",
    });
  };
  return Object.freeze({
    async createSession(input, secrets) {
      const customerId = input.phone === "13900000002" ? CUSTOMER_B : CUSTOMER;
      const identity = Object.freeze({
        sessionId: randomUUID(),
        orgId: ORG,
        storeId: STORE,
        customerId,
        csrfHash: secrets.csrfHash,
        authorityHash: secrets.authorityHash,
        expiresAt: new Date("2026-08-13T01:15:00.000Z"),
      });
      sessions = new Map(sessions).set(secrets.sessionHash, { identity, active: true });
      return identity;
    },
    async resolveSession(sessionHash) {
      const session = sessions.get(sessionHash);
      return session?.active === true ? session.identity : null;
    },
    async revokeSession(sessionHash, csrfHash, authorityHash) {
      const session = sessions.get(sessionHash);
      if (
        session?.active !== true ||
        session.identity.csrfHash !== csrfHash ||
        session.identity.authorityHash !== authorityHash
      ) {
        return false;
      }
      sessions = new Map(sessions).set(sessionHash, { ...session, active: false });
      return true;
    },
    async executeQuery(identity, _sessionHash, name) {
      const orderSummary = summaryFor(identity.customerId);
      const garmentId = identity.customerId === CUSTOMER_B ? GARMENT_B : GARMENT;
      if (name === "customer.self_service.orders.list") {
        return Object.freeze({ orders: Object.freeze([orderSummary]) });
      }
      if (name === "customer.self_service.order.get") {
        return Object.freeze({ order: orderSummary, lines: Object.freeze([]) });
      }
      if (name === "customer.self_service.garment.progress") {
        return Object.freeze({
          garment: Object.freeze({
            garment_id: garmentId,
            order_id: orderSummary.order_id,
            seq: 1,
            service_code: "wash",
            category_code: "shirt",
            color: null,
            brand: null,
            status: "washing" as const,
          }),
          progress: Object.freeze([]),
        });
      }
      return null;
    },
  });
}

class TestCookieJar {
  #values: ReadonlyMap<string, string> = new Map();

  apply(headers: Readonly<Record<string, unknown>>): void {
    const raw = headers["set-cookie"];
    const lines: readonly string[] = Array.isArray(raw)
      ? raw.filter((value): value is string => typeof value === "string")
      : typeof raw === "string"
        ? [raw]
        : [];
    const next = new Map(this.#values);
    for (const line of lines) {
      const [pair = "", ...attributes] = line.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (attributes.some((attribute) => attribute.trim().toLowerCase() === "max-age=0")) {
        next.delete(name);
      } else {
        next.set(name, value);
      }
    }
    this.#values = next;
  }

  header(): string {
    return [...this.#values].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  csrf(authority: string): string {
    const local = customerPortalCookieNames(cookieSelector(authority), false)?.csrf;
    const secure = customerPortalCookieNames(cookieSelector(authority), true)?.csrf;
    return (
      (local === undefined ? undefined : this.#values.get(local)) ??
      (secure === undefined ? "" : (this.#values.get(secure) ?? ""))
    );
  }
}

async function appFor(store: CustomerPortalStore, maxQueries = 60) {
  return createLocalApp({
    runtime: await createMemoryLocalRuntime(),
    cookiePolicy: resolveCookiePolicy({ secure: false }),
    customerPortalStore: store,
    customerPortalLoginTimingGuard: createCustomerPortalLoginTimingGuard({
      minimumResponseMs: 1,
      nowMs: () => 0,
      waitMs: async () => undefined,
    }),
    customerPortalQueryRateLimiter: createCustomerPortalQueryRateLimiter({ maxQueries }),
    logger: false,
  });
}

function portalHeaders(jar: TestCookieJar, authority: string | null) {
  return Object.freeze({
    host: "127.0.0.1:8787",
    origin: "http://127.0.0.1:5173",
    "sec-fetch-site": "same-site",
    cookie: jar.header(),
    ...(authority === null
      ? {}
      : {
          [CSRF_HEADER_NAME]: jar.csrf(authority),
          [CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME]: authority,
        }),
  });
}

async function raceLogin(
  app: Awaited<ReturnType<typeof appFor>>,
  phone: string,
  authority: string,
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/customer/auth/login",
    headers: Object.freeze({
      host: "127.0.0.1:8787",
      origin: "http://127.0.0.1:5173",
      "sec-fetch-site": "same-site",
      [CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME]: authority,
    }),
    payload: {
      org_code: "local",
      store_code: "main",
      phone,
      pickup_code: "PK0001",
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(Array.isArray(response.headers["set-cookie"]), true);
  return response;
}

async function assertCustomerReadsRejected(
  app: Awaited<ReturnType<typeof appFor>>,
  jar: TestCookieJar,
  authority: string | null,
): Promise<void> {
  const requests = [
    ["customer.self_service.orders.list", {}],
    ["customer.self_service.order.get", { order_id: ORDER_B }],
    ["customer.self_service.garment.progress", { order_id: ORDER_B, garment_id: GARMENT_B }],
  ] as const;
  for (const [name, payload] of requests) {
    const response = await app.inject({
      method: "POST",
      url: `/v1/queries/${name}`,
      headers: portalHeaders(jar, authority),
      payload,
    });
    assert.equal(response.statusCode, 401, `${name}: ${response.body}`);
    assert.doesNotMatch(response.body, /CUSTOMER-[AB]/u);
  }
}

async function assertCustomerReadsBelongTo(
  app: Awaited<ReturnType<typeof appFor>>,
  jar: TestCookieJar,
  authority: string,
  expected: "A" | "B",
): Promise<void> {
  const orderId = expected === "A" ? ORDER : ORDER_B;
  const garmentId = expected === "A" ? GARMENT : GARMENT_B;
  const marker = expected === "A" ? "CUSTOMER-A-PII" : "CUSTOMER-B-ONLY";
  const requests = [
    ["customer.self_service.orders.list", {}],
    ["customer.self_service.order.get", { order_id: orderId }],
    ["customer.self_service.garment.progress", { order_id: orderId, garment_id: garmentId }],
  ] as const;
  for (const [name, payload] of requests) {
    const response = await app.inject({
      method: "POST",
      url: `/v1/queries/${name}`,
      headers: portalHeaders(jar, authority),
      payload,
    });
    assert.equal(response.statusCode, 200, `${name}: ${response.body}`);
    const ownEvidence = name.endsWith("garment.progress") ? garmentId : marker;
    const otherEvidence = name.endsWith("garment.progress")
      ? expected === "A"
        ? GARMENT_B
        : GARMENT
      : expected === "A"
        ? "CUSTOMER-B-ONLY"
        : "CUSTOMER-A-PII";
    assert.match(response.body, new RegExp(ownEvidence, "u"));
    assert.doesNotMatch(response.body, new RegExp(otherEvidence, "u"));
  }
}

async function login(app: Awaited<ReturnType<typeof appFor>>) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/customer/auth/login",
    headers: browserHeaders,
    payload: {
      org_code: "local",
      store_code: "main",
      phone: "13800000001",
      pickup_code: "PK0001",
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "no-store");
  const cookies = cookiesFrom(response.headers);
  const names = customerPortalCookieNames(cookieSelector(AUTHORITY), false);
  assert.ok(names);
  return Object.freeze({
    cookie: Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; "),
    [CSRF_HEADER_NAME]: cookies[names.csrf] ?? "",
  });
}

async function staffLogin(app: Awaited<ReturnType<typeof appFor>>) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: browserHeaders,
    payload: {
      org_code: "local",
      store_code: "main",
      username: "admin",
      password: DEMO_PASSWORD,
      device_id: "99999999-9999-4999-8999-999999999999",
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const cookies = cookiesFrom(response.headers);
  return Object.freeze({
    authorization: `Bearer ${(response.json() as { data: { access_token: string } }).data.access_token}`,
    cookie: Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; "),
    [CSRF_HEADER_NAME]: cookies[LOCAL_COOKIE_NAMES.csrf] ?? "",
  });
}

test("customer portal login is non-enumerating and hard-off by absent authority", async () => {
  const app = await appFor(fakeStore({ authenticate: false }));
  const request = (phone: string, pickupCode: string) =>
    app.inject({
      method: "POST",
      url: "/api/v2/customer/auth/login",
      headers: browserHeaders,
      payload: { org_code: "local", store_code: "main", phone, pickup_code: pickupCode },
    });
  const wrongCustomer = await request("13800000001", "PK-MISSING");
  const wrongTenant = await request("13900000001", "PK-OTHER");
  assert.equal(wrongCustomer.statusCode, 401);
  assert.equal(wrongTenant.statusCode, 401);
  assert.deepEqual(wrongCustomer.json(), wrongTenant.json());
  assert.doesNotMatch(wrongCustomer.body, /138|139|PK-/u);
  await app.close();
});

test("customer portal login requires a valid per-tab authority before setting cookies", async () => {
  const app = await appFor(raceStore());
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/customer/auth/login",
    headers: Object.freeze({
      host: "127.0.0.1:8787",
      origin: "http://127.0.0.1:5173",
      "sec-fetch-site": "same-site",
    }),
    payload: {
      org_code: "local",
      store_code: "main",
      phone: "13800000001",
      pickup_code: "PK0001",
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.headers["set-cookie"], undefined);
  await app.close();
});

test("local browser CORS preflight permits the frozen tab-authority header", async () => {
  const app = await appFor(fakeStore());
  const response = await app.inject({
    method: "OPTIONS",
    url: "/api/v2/customer/auth/session",
    headers: {
      host: "127.0.0.1:8787",
      origin: "http://127.0.0.1:5173",
      "access-control-request-method": "GET",
      "access-control-request-headers": CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME,
    },
  });
  assert.equal(response.statusCode, 204, response.body);
  assert.equal(response.headers["access-control-allow-origin"], "http://127.0.0.1:5173");
  assert.match(
    String(response.headers["access-control-allow-headers"]),
    new RegExp(CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME, "iu"),
  );
  await app.close();
});

test("customer portal queries require CSRF and return only strict customer-safe fields", async () => {
  const app = await appFor(fakeStore());
  const auth = await login(app);
  const missingCsrf = await app.inject({
    method: "POST",
    url: "/v1/queries/customer.self_service.orders.list",
    headers: Object.freeze({ ...browserHeaders, cookie: auth.cookie }),
    payload: {},
  });
  assert.equal(missingCsrf.statusCode, 403);
  const response = await app.inject({
    method: "POST",
    url: "/v1/queries/customer.self_service.orders.list",
    headers: Object.freeze({ ...browserHeaders, ...auth }),
    payload: { limit: 20 },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as { data: { result: { orders: readonly unknown[] } } };
  assert.deepEqual(body.data.result.orders, [summary]);
  assert.doesNotMatch(response.body, /customer_phone|customer_name|note|staff|barcode|reason/iu);
  await app.close();
});

test("customer receipt route accepts the production balance-ledger payment method", async () => {
  const app = await appFor(fakeStore());
  const auth = await login(app);
  const response = await app.inject({
    method: "POST",
    url: "/v1/queries/customer.self_service.receipt.get",
    headers: Object.freeze({ ...browserHeaders, ...auth }),
    payload: { order_id: ORDER },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as {
    data: { result: { receipt: { payments: readonly { method: string }[] } } };
  };
  assert.equal(body.data.result.receipt.payments[0]?.method, "balance");
  await app.close();
});

test("staff and customer authorities cannot cross into each other's query surface", async () => {
  const app = await appFor(fakeStore());
  const [staffAuth, customerAuth] = await Promise.all([staffLogin(app), login(app)]);
  const staffOnCustomerRoute = await app.inject({
    method: "POST",
    url: "/v1/queries/customer.self_service.orders.list",
    headers: Object.freeze({ ...browserHeaders, ...staffAuth }),
    payload: {},
  });
  assert.equal(staffOnCustomerRoute.statusCode, 401, staffOnCustomerRoute.body);
  const customerOnStaffRoute = await app.inject({
    method: "POST",
    url: "/v1/queries/order.list",
    headers: Object.freeze({ ...browserHeaders, ...customerAuth }),
    payload: {},
  });
  assert.equal(customerOnStaffRoute.statusCode, 401, customerOnStaffRoute.body);
  await app.close();
});

test("cross-customer and nonexistent order guesses share one unavailable response", async () => {
  const other = "77777777-7777-4777-8777-777777777777";
  const missing = "88888888-8888-4888-8888-888888888888";
  const app = await appFor(fakeStore({ unavailableIds: new Set([other, missing]) }));
  const auth = await login(app);
  const query = (orderId: string) =>
    app.inject({
      method: "POST",
      url: "/v1/queries/customer.self_service.order.get",
      headers: Object.freeze({ ...browserHeaders, ...auth }),
      payload: { order_id: orderId },
    });
  const crossCustomer = await query(other);
  const nonexistent = await query(missing);
  assert.equal(crossCustomer.statusCode, 404);
  assert.equal(nonexistent.statusCode, 404);
  assert.deepEqual(crossCustomer.json(), nonexistent.json());
  assert.doesNotMatch(crossCustomer.body, new RegExp(other, "u"));
  await app.close();
});

test("customer session revocation is CSRF-bound and immediately invalidates reads", async () => {
  const app = await appFor(fakeStore());
  const auth = await login(app);
  const rejected = await app.inject({
    method: "POST",
    url: "/api/v2/customer/auth/logout",
    headers: Object.freeze({ ...browserHeaders, cookie: auth.cookie, [CSRF_HEADER_NAME]: "wrong" }),
    payload: {},
  });
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.headers["cache-control"], "no-store");
  const invalidBody = await app.inject({
    method: "POST",
    url: "/api/v2/customer/auth/logout",
    headers: Object.freeze({ ...browserHeaders, ...auth }),
    payload: { unexpected: true },
  });
  assert.equal(invalidBody.statusCode, 400, invalidBody.body);
  const loggedOut = await app.inject({
    method: "POST",
    url: "/api/v2/customer/auth/logout",
    headers: Object.freeze({ ...browserHeaders, ...auth }),
    payload: {},
  });
  assert.equal(loggedOut.statusCode, 200, loggedOut.body);
  assert.equal(loggedOut.headers["cache-control"], "no-store");
  assert.equal(Array.isArray(loggedOut.headers["set-cookie"]), true);
  const after = await app.inject({
    method: "POST",
    url: "/v1/queries/customer.self_service.orders.list",
    headers: Object.freeze({ ...browserHeaders, ...auth }),
    payload: {},
  });
  assert.equal(after.statusCode, 401);
  await app.close();
});

test("customer queries use a dedicated bounded session and IP rate limit", async () => {
  const app = await appFor(fakeStore(), 1);
  const auth = await login(app);
  const request = () =>
    app.inject({
      method: "POST",
      url: "/v1/queries/customer.self_service.orders.list",
      headers: Object.freeze({ ...browserHeaders, ...auth }),
      payload: {},
    });
  assert.equal((await request()).statusCode, 200);
  const limited = await request();
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers["retry-after"], "60");
  await app.close();
});

test("logout revokes after the shared read bucket is exhausted and clears its selected cookies", async () => {
  const app = await appFor(fakeStore(), 1);
  const auth = await login(app);
  const jar = new TestCookieJar();
  jar.apply({ "set-cookie": auth.cookie.split("; ") });
  const resumed = await app.inject({
    method: "GET",
    url: "/api/v2/customer/auth/session",
    headers: portalHeaders(jar, AUTHORITY),
  });
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.equal(resumed.headers["cache-control"], "no-store");
  const logout = await app.inject({
    method: "POST",
    url: "/api/v2/customer/auth/logout",
    headers: portalHeaders(jar, AUTHORITY),
    payload: {},
  });
  assert.equal(logout.statusCode, 200, logout.body);
  assert.equal(logout.headers["retry-after"], undefined);
  assert.equal(logout.headers["cache-control"], "no-store");
  jar.apply(logout.headers);
  assert.equal(jar.header(), "");
  const after = await app.inject({
    method: "GET",
    url: "/api/v2/customer/auth/session",
    headers: Object.freeze({ ...portalHeaders(jar, AUTHORITY), cookie: auth.cookie }),
  });
  assert.equal(after.statusCode, 401, after.body);
  await app.close();
});

test("strict output validation fails closed instead of leaking internal fields", async () => {
  const app = await appFor(
    fakeStore({ resultOverride: { orders: [{ ...summary, internal_note: "do not expose" }] } }),
  );
  const auth = await login(app);
  const response = await app.inject({
    method: "POST",
    url: "/v1/queries/customer.self_service.orders.list",
    headers: Object.freeze({ ...browserHeaders, ...auth }),
    payload: {},
  });
  assert.equal(response.statusCode, 500);
  assert.doesNotMatch(response.body, /internal_note|do not expose/u);
  await app.close();
});

test("tab-scoped Set-Cookie and Clear-Cookie races never invalidate customer B", async () => {
  const app = await appFor(raceStore());
  const [oldCustomerA, newCustomerB] = await Promise.all([
    raceLogin(app, "13800000001", AUTHORITY),
    raceLogin(app, "13900000002", AUTHORITY_B),
  ]);
  const jar = new TestCookieJar();
  jar.apply(newCustomerB.headers);
  jar.apply(oldCustomerA.headers);
  await assertCustomerReadsBelongTo(app, jar, AUTHORITY_B, "B");

  const lateResume = await app.inject({
    method: "GET",
    url: "/api/v2/customer/auth/session",
    headers: portalHeaders(jar, AUTHORITY),
  });
  assert.equal(lateResume.statusCode, 200, lateResume.body);
  jar.apply(lateResume.headers);
  await assertCustomerReadsBelongTo(app, jar, AUTHORITY_B, "B");

  const lateLogout = await app.inject({
    method: "POST",
    url: "/api/v2/customer/auth/logout",
    headers: portalHeaders(jar, AUTHORITY),
    payload: {},
  });
  assert.equal(lateLogout.statusCode, 200, lateLogout.body);
  jar.apply(lateLogout.headers);
  await assertCustomerReadsBelongTo(app, jar, AUTHORITY_B, "B");

  jar.apply(oldCustomerA.headers);
  await assertCustomerReadsBelongTo(app, jar, AUTHORITY_B, "B");
  const rejectedAResume = await app.inject({
    method: "GET",
    url: "/api/v2/customer/auth/session",
    headers: portalHeaders(jar, AUTHORITY),
  });
  assert.equal(rejectedAResume.statusCode, 401, rejectedAResume.body);
  jar.apply(rejectedAResume.headers);
  await assertCustomerReadsBelongTo(app, jar, AUTHORITY_B, "B");

  await assertCustomerReadsRejected(app, jar, null);
  await assertCustomerReadsRejected(app, jar, AUTHORITY);
  await app.close();
});
