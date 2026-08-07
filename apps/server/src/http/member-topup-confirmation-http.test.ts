import assert from "node:assert/strict";
import test from "node:test";

import { CSRF_HEADER_NAME } from "@laundry/contracts";

import { DEMO_CUSTOMERS } from "../customer/memory-store.js";
import {
  createMemoryLocalRuntime,
  DEMO_ADMIN_ID,
  DEMO_PASSWORD,
  DEMO_STORE_ID,
} from "../local/demo-seed.js";
import { createLocalApp } from "./create-app.js";
import { resolveCookiePolicy } from "./cookie-policy.js";
import { LOCAL_COOKIE_NAMES } from "./types.js";

const DEVICE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const browserMutationHeaders = Object.freeze({
  host: "127.0.0.1:8787",
  origin: "http://127.0.0.1:5173",
  "sec-fetch-site": "same-site",
});

function cookiesFrom(headers: Record<string, unknown>): Readonly<Record<string, string>> {
  const raw = headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return Object.freeze(
    Object.fromEntries(
      values.flatMap((line) => {
        const pair = line.split(";", 1)[0];
        const separator = pair?.indexOf("=") ?? -1;
        return pair === undefined || separator <= 0
          ? []
          : [[pair.slice(0, separator), pair.slice(separator + 1)]];
      }),
    ),
  );
}

test("member top-up HTTP confirmation freezes its exact bonus summary", async () => {
  const runtime = await createMemoryLocalRuntime();
  const app = await createLocalApp({
    runtime,
    cookiePolicy: resolveCookiePolicy({ secure: false }),
    logger: false,
  });
  const customer = DEMO_CUSTOMERS[0];
  assert.ok(customer);
  const opened = await runtime.member.store.openAccount({
    customer_id: customer.customer_id,
    store_id: DEMO_STORE_ID,
    at: 1_780_000_000,
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const rule = await runtime.member.store.upsertBonusRule({
    rule_id: null,
    min_topup_cents: 100_000,
    bonus_cents: 10_000,
    status: "active",
    staff_id: DEMO_ADMIN_ID,
    at: 1_780_000_001,
    note: null,
  });
  assert.equal(rule.ok, true);
  if (!rule.ok) return;

  const login = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: browserMutationHeaders,
    payload: {
      org_code: "local",
      store_code: "main",
      username: "admin",
      password: DEMO_PASSWORD,
      device_id: DEVICE,
    },
  });
  assert.equal(login.statusCode, 200, login.body);
  const loginBody = login.json() as { data: { access_token: string } };
  const cookies = cookiesFrom(login.headers as Record<string, unknown>);
  const commandHeaders = Object.freeze({
    ...browserMutationHeaders,
    authorization: `Bearer ${loginBody.data.access_token}`,
    cookie: Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; "),
    [CSRF_HEADER_NAME]: cookies[LOCAL_COOKIE_NAMES.csrf] ?? "",
  });

  const first = await app.inject({
    method: "POST",
    url: "/v1/commands/member.topup",
    headers: commandHeaders,
    payload: {
      account_id: opened.value.account.account_id,
      amount_cents: 100_000,
      method: "cash",
    },
  });
  assert.equal(first.statusCode, 403, first.body);
  const firstBody = first.json() as {
    error: {
      code: string;
      detail: {
        confirm_ref: string;
        summary: {
          kind: string;
          principal_cents: number;
          bonus_cents: number;
          credited_cents: number;
          matched_rule: { rule_id: string; min_topup_cents: number; bonus_cents: number } | null;
        };
      };
    };
  };
  assert.equal(firstBody.error.code, "POLICY_CONFIRMATION_REQUIRED");
  assert.deepEqual(firstBody.error.detail.summary, {
    kind: "member_topup",
    principal_cents: 100_000,
    bonus_cents: 10_000,
    credited_cents: 110_000,
    matched_rule: {
      rule_id: rule.value.rule_id,
      min_topup_cents: 100_000,
      bonus_cents: 10_000,
    },
  });

  const staffLogin = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: browserMutationHeaders,
    payload: {
      org_code: "local",
      store_code: "main",
      username: "staff",
      password: DEMO_PASSWORD,
      device_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    },
  });
  assert.equal(staffLogin.statusCode, 200, staffLogin.body);
  const staffLoginBody = staffLogin.json() as { data: { access_token: string } };
  const staffCookies = cookiesFrom(staffLogin.headers as Record<string, unknown>);
  const crossStaff = await app.inject({
    method: "POST",
    url: "/v1/commands/member.topup",
    headers: {
      ...browserMutationHeaders,
      authorization: `Bearer ${staffLoginBody.data.access_token}`,
      cookie: Object.entries(staffCookies)
        .map(([name, value]) => `${name}=${value}`)
        .join("; "),
      [CSRF_HEADER_NAME]: staffCookies[LOCAL_COOKIE_NAMES.csrf] ?? "",
    },
    payload: { confirm_ref: firstBody.error.detail.confirm_ref },
  });
  assert.equal(crossStaff.statusCode, 403, crossStaff.body);
  assert.equal((crossStaff.json() as { error?: { code?: string } }).error?.code, "POLICY_DENIED");

  await runtime.member.store.upsertBonusRule({
    rule_id: rule.value.rule_id,
    min_topup_cents: 100_000,
    bonus_cents: 1,
    status: "active",
    staff_id: DEMO_ADMIN_ID,
    at: 1_780_000_002,
    note: null,
  });
  const rejectedPreview = await app.inject({
    method: "POST",
    url: "/v1/commands/member.topup",
    headers: commandHeaders,
    payload: {
      command: "member.topup",
      version: "1.0.0",
      mode: "confirm",
      confirm_ref: firstBody.error.detail.confirm_ref,
      idempotency_key: firstBody.error.detail.confirm_ref,
      dry_run: true,
    },
  });
  assert.equal(rejectedPreview.statusCode, 400, rejectedPreview.body);
  assert.equal(
    (rejectedPreview.json() as { error?: { code?: string } }).error?.code,
    "VALIDATION_FAILED",
  );
  assert.doesNotMatch(rejectedPreview.body, /account_id|amount_cents|100000/iu);

  const confirmed = await app.inject({
    method: "POST",
    url: "/v1/commands/member.topup",
    headers: commandHeaders,
    payload: { confirm_ref: firstBody.error.detail.confirm_ref },
  });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  const view = await runtime.member.store.getByCustomer(customer.customer_id, 10);
  assert.equal(view?.balance.principal_cents, 100_000);
  assert.equal(view?.balance.bonus_cents, 10_000);
  assert.equal(view?.recent[0]?.bonus_rule_id, rule.value.rule_id);
  await app.close();
});
