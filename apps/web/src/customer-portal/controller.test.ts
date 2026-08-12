import assert from "node:assert/strict";
import test from "node:test";

import type { CustomerPortalLoginInput, CustomerPortalOrderSummary } from "@laundry/contracts";

import type { CustomerPortalClient, CustomerPortalResult } from "./client.js";
import { createCustomerPortalController } from "./controller.js";

const ORDER_A = "11111111-1111-4111-8111-111111111111";
const ORDER_B = "22222222-2222-4222-8222-222222222222";
const GARMENT_A = "33333333-3333-4333-8333-333333333333";
const PAYMENT_A = "44444444-4444-4444-8444-444444444444";

function order(orderId: string, ticketNo: string): CustomerPortalOrderSummary {
  return Object.freeze({
    order_id: orderId,
    ticket_no: ticketNo,
    status: "open",
    payable_cents: 1_000,
    paid_cents: 1_000,
    balance_cents: 0,
    garment_count: 1,
    created_at: "2026-08-13T01:00:00.000Z",
    updated_at: "2026-08-13T01:10:00.000Z",
  });
}

const SUMMARY_A = order(ORDER_A, "CUSTOMER-A-PII");
const SUMMARY_B = order(ORDER_B, "CUSTOMER-B-ONLY");
const LOGIN: CustomerPortalLoginInput = Object.freeze({
  org_code: "local",
  store_code: "main",
  phone: "13800000001",
  pickup_code: "PK0001",
});

function success<T>(data: T): CustomerPortalResult<T> {
  return Object.freeze({ ok: true as const, data });
}

function failure<T>(): CustomerPortalResult<T> {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ code: "AUTHENTICATION_FAILED", message: "not signed in" }),
  });
}

function deferred<T>() {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({
    promise,
    resolve(value: T): void {
      assert.ok(resolvePromise);
      resolvePromise(value);
    },
  });
}

test("logout and another customer login cannot revive deferred prior-session PII", async () => {
  const oldRefresh = deferred<CustomerPortalResult<readonly CustomerPortalOrderSummary[]>>();
  const newLoginOrders = deferred<CustomerPortalResult<readonly CustomerPortalOrderSummary[]>>();
  const listSignals: AbortSignal[] = [];
  let listCalls = 0;
  let invalidations = 0;
  const client: CustomerPortalClient = Object.freeze({
    invalidateLocalSession() {
      invalidations += 1;
    },
    async resume() {
      return failure();
    },
    async login() {
      return success(Object.freeze({ authenticated: true as const, expires_at: 1_800_000_000 }));
    },
    async logout() {
      return success(Object.freeze({ logged_out: true as const }));
    },
    async listOrders(_limit, signal) {
      assert.ok(signal);
      listSignals.push(signal);
      listCalls += 1;
      if (listCalls === 1) return success(Object.freeze([SUMMARY_A]));
      if (listCalls === 2) return oldRefresh.promise;
      return newLoginOrders.promise;
    },
    async getOrder() {
      return success(Object.freeze({ order: SUMMARY_A, lines: Object.freeze([]) }));
    },
    async getReceipt() {
      return success(
        Object.freeze({
          receipt: Object.freeze({
            order_id: ORDER_A,
            ticket_no: SUMMARY_A.ticket_no,
            business_date: "2026-08-13",
            original_cents: 1_000,
            discount_cents: 0,
            addon_cents: 0,
            urgent_cents: 0,
            freight_cents: 0,
            payable_cents: 1_000,
            paid_cents: 1_000,
            balance_cents: 0,
            created_at: SUMMARY_A.created_at,
            lines: Object.freeze([]),
            payments: Object.freeze([
              Object.freeze({
                payment_id: PAYMENT_A,
                method: "balance" as const,
                kind: "pay" as const,
                amount_cents: 1_000,
                at: SUMMARY_A.created_at,
              }),
            ]),
          }),
        }),
      );
    },
    async listGarments() {
      return success(
        Object.freeze({
          garments: Object.freeze([
            Object.freeze({
              garment_id: GARMENT_A,
              order_id: ORDER_A,
              seq: 1,
              service_code: "wash",
              category_code: "shirt",
              color: null,
              brand: null,
              status: "washing" as const,
            }),
          ]),
        }),
      );
    },
    async getGarmentProgress() {
      return success(
        Object.freeze({
          garment: Object.freeze({
            garment_id: GARMENT_A,
            order_id: ORDER_A,
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
              at: SUMMARY_A.updated_at,
            }),
          ]),
        }),
      );
    },
  });

  const controller = createCustomerPortalController(client);
  await controller.login(LOGIN);
  await controller.selectOrder(ORDER_A);
  await controller.loadProgress(ORDER_A, GARMENT_A);
  assert.equal(controller.getSnapshot().detail?.receipt.receipt.ticket_no, "CUSTOMER-A-PII");
  assert.ok(controller.getSnapshot().progress[GARMENT_A]);

  const staleLoad = controller.loadOrders();
  assert.equal(listCalls, 2);
  const logout = controller.logout();
  assert.equal(listSignals[1]?.aborted, true);
  assert.deepEqual(controller.getSnapshot().orders, []);
  assert.equal(controller.getSnapshot().selectedOrderId, null);
  assert.equal(controller.getSnapshot().detail, null);
  assert.deepEqual(controller.getSnapshot().progress, {});
  await logout;

  const nextLogin = controller.login({ ...LOGIN, phone: "13900000002" });
  await Promise.resolve();
  assert.equal(listCalls, 3);
  newLoginOrders.resolve(success(Object.freeze([SUMMARY_B])));
  await nextLogin;
  assert.deepEqual(controller.getSnapshot().orders, [SUMMARY_B]);

  oldRefresh.resolve(success(Object.freeze([SUMMARY_A])));
  await staleLoad;
  assert.deepEqual(controller.getSnapshot().orders, [SUMMARY_B]);
  assert.equal(JSON.stringify(controller.getSnapshot()).includes("CUSTOMER-A-PII"), false);
  assert.equal(invalidations, 0);
  controller.dispose();
});

test("server expiry atomically clears customer PII, authority and in-flight work", async () => {
  const START_MS = 1_800_000_000_000;
  let nowMs = START_MS;
  let nextTimer = 1;
  let invalidations = 0;
  let timers: ReadonlyMap<number, Readonly<{ at: number; callback: () => void }>> = new Map();
  const pendingRefresh = deferred<CustomerPortalResult<readonly CustomerPortalOrderSummary[]>>();
  const refreshSignals: AbortSignal[] = [];
  let listCalls = 0;
  const client: CustomerPortalClient = Object.freeze({
    invalidateLocalSession() {
      invalidations += 1;
    },
    async resume() {
      return failure();
    },
    async login() {
      return success(
        Object.freeze({ authenticated: true as const, expires_at: (START_MS + 5_000) / 1_000 }),
      );
    },
    async logout() {
      return success(Object.freeze({ logged_out: true as const }));
    },
    async listOrders(_limit, signal) {
      listCalls += 1;
      if (listCalls === 1) return success(Object.freeze([SUMMARY_A]));
      if (signal !== undefined) refreshSignals.push(signal);
      return pendingRefresh.promise;
    },
    async getOrder() {
      return success(Object.freeze({ order: SUMMARY_A, lines: Object.freeze([]) }));
    },
    async getReceipt() {
      return success(
        Object.freeze({
          receipt: Object.freeze({
            order_id: ORDER_A,
            ticket_no: SUMMARY_A.ticket_no,
            business_date: "2026-08-13",
            original_cents: 1_000,
            discount_cents: 0,
            addon_cents: 0,
            urgent_cents: 0,
            freight_cents: 0,
            payable_cents: 1_000,
            paid_cents: 1_000,
            balance_cents: 0,
            created_at: SUMMARY_A.created_at,
            lines: Object.freeze([]),
            payments: Object.freeze([]),
          }),
        }),
      );
    },
    async listGarments() {
      return success(
        Object.freeze({
          garments: Object.freeze([
            Object.freeze({
              garment_id: GARMENT_A,
              order_id: ORDER_A,
              seq: 1,
              service_code: "wash",
              category_code: "shirt",
              color: null,
              brand: null,
              status: "washing" as const,
            }),
          ]),
        }),
      );
    },
    async getGarmentProgress() {
      return success(
        Object.freeze({
          garment: Object.freeze({
            garment_id: GARMENT_A,
            order_id: ORDER_A,
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
              at: SUMMARY_A.updated_at,
            }),
          ]),
        }),
      );
    },
  });
  const controller = createCustomerPortalController(client, {
    nowMs: () => nowMs,
    setTimer: (callback, delayMs) => {
      const id = nextTimer;
      nextTimer += 1;
      timers = new Map(timers).set(id, { at: nowMs + delayMs, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle) => {
      const next = new Map(timers);
      next.delete(handle as unknown as number);
      timers = next;
    },
  });

  await controller.login(LOGIN);
  await controller.selectOrder(ORDER_A);
  await controller.loadProgress(ORDER_A, GARMENT_A);
  const refresh = controller.loadOrders();
  assert.ok(refreshSignals[0]);

  nowMs += 5_000;
  const due = [...timers.values()].filter((timer) => timer.at <= nowMs);
  for (const timer of due) timer.callback();
  assert.equal(refreshSignals[0]?.aborted, true);
  assert.deepEqual(controller.getSnapshot(), {
    authenticated: false,
    orders: [],
    selectedOrderId: null,
    detail: null,
    progress: {},
    busy: false,
    error: null,
  });
  assert.equal(invalidations, 1);

  pendingRefresh.resolve(success(Object.freeze([SUMMARY_B])));
  await refresh;
  assert.equal(JSON.stringify(controller.getSnapshot()).includes("CUSTOMER-B-ONLY"), false);
  controller.dispose();
});
