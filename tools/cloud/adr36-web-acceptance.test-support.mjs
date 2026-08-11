import assert from "node:assert/strict";

import { ADR36_PUBLIC_ORIGIN } from "./adr36-web-acceptance.mjs";

const ADMIN_ID = "11111111-1111-4111-8111-111111111101";
const APPROVER_ID = "11111111-1111-4111-8111-111111111102";
const ORG_ID = "11111111-1111-4111-8111-111111111103";
const STORE_ID = "11111111-1111-4111-8111-111111111104";
const ADMIN_SESSION_ID = "11111111-1111-4111-8111-111111111105";
const APPROVER_SESSION_ID = "11111111-1111-4111-8111-111111111106";
const ADMIN_DEVICE_ID = "11111111-1111-4111-8111-111111111107";
const APPROVER_DEVICE_ID = "11111111-1111-4111-8111-111111111108";
const CUSTOMER_ID = "22222222-2222-4222-8222-222222222201";
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333301";
const RULE_ID = "44444444-4444-4444-8444-444444444401";
const ORDER_IDS = ["55555555-5555-4555-8555-555555555501", "55555555-5555-4555-8555-555555555502"];
const GARMENT_IDS = [
  "66666666-6666-4666-8666-666666666601",
  "66666666-6666-4666-8666-666666666602",
];
const EXPECTED_DELTA = Object.freeze({
  real_income_cents: 4_200,
  performance_income_cents: 5_200,
  order_cashflow_cents: 2_600,
  stored_value_cashflow_cents: 1_600,
  stored_value_consumption_cents: 2_600,
  ledger_row_count: 6,
});
const ZERO_BASIS = Object.freeze(
  Object.fromEntries(Object.keys(EXPECTED_DELTA).map((key) => [key, 0])),
);

function acceptanceEnvironment() {
  return Object.freeze({
    LAUNDRY_BOOTSTRAP_ADMIN_USERNAME: "uat_owner",
    LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME: "ADR36 UAT Owner",
    LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD: "Admin-Secret-Do-Not-Print",
    LAUNDRY_BOOTSTRAP_ADMIN_PIN: "740193",
    LAUNDRY_BOOTSTRAP_APPROVER_USERNAME: "uat_approver",
    LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME: "ADR36 UAT Approver",
    LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD: "Approver-Secret-Do-Not-Print",
    LAUNDRY_BOOTSTRAP_APPROVER_PIN: "850274",
  });
}

function sequentialUuid() {
  let sequence = 1;
  return () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
}

function jsonResponse(body, status = 200, cookies = []) {
  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

function invalidJsonResponse(body, status = 200, cookies = []) {
  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(body, { status, headers });
}

function authCookies(index, clear = false, sameValue = false) {
  const csrfProof = clear ? "" : `v1.${String(index).padStart(96, "A")}`;
  const refresh = clear ? "" : sameValue ? csrfProof : `secret-refresh-${index}`;
  const csrf = csrfProof;
  const maxAge = clear ? "; Max-Age=0" : "";
  return [
    `__Host-laundry_refresh=${refresh}${maxAge}; Path=/; HttpOnly; Secure; SameSite=Strict`,
    `__Host-laundry_csrf=${csrf}${maxAge}; Path=/; Secure; SameSite=Strict`,
  ];
}

function success(result) {
  return jsonResponse({ ok: true, data: { execution: "executed", result } });
}

function gate(code, confirmRef) {
  return jsonResponse(
    {
      ok: false,
      error: { code, message: "sensitive response body", detail: { confirm_ref: confirmRef } },
    },
    403,
  );
}

function failure(code) {
  return jsonResponse({ ok: false, error: { code, message: "sensitive response body" } }, 409);
}

function createFakeCloud(env, fakeOptions = {}) {
  const requests = [];
  const postCommitFailures = [...(fakeOptions.postCommitFailures ?? [])];
  const pending = new Map();
  const approved = new Set();
  const orders = new Map();
  const accessTokens = new Map();
  const revokedAuthorizations = new Set();
  const revokedCookieHeaders = new Set();
  let cookieSequence = 0;
  let tokenSequence = 0;
  const sessionVersions = new Map();
  let challengeSequence = 0;
  let pendingSequence = 0;
  let catalog = null;
  let catalogAudits = Object.freeze([]);
  let bonusRule = null;
  let account = null;
  let financialComplete = false;

  const staffByUsername = Object.freeze({
    [env.LAUNDRY_BOOTSTRAP_ADMIN_USERNAME]: Object.freeze({
      staffId: ADMIN_ID,
      displayName: env.LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME,
      password: env.LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD,
    }),
    [env.LAUNDRY_BOOTSTRAP_APPROVER_USERNAME]: Object.freeze({
      staffId: APPROVER_ID,
      displayName: env.LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME,
      password: env.LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD,
    }),
  });

  const authData = (staff, reuseExisting = false, retainSessionVersion = false) => {
    const existing = accessTokens.get(staff.staffId);
    const token =
      reuseExisting && existing !== undefined
        ? existing
        : `private.${staff.staffId}.${++tokenSequence}`;
    accessTokens.set(staff.staffId, token);
    const previousSessionVersion = sessionVersions.get(staff.staffId) ?? 0;
    const sessionVersion = retainSessionVersion
      ? previousSessionVersion
      : previousSessionVersion + 1;
    assert.ok(sessionVersion > 0);
    sessionVersions.set(staff.staffId, sessionVersion);
    const admin = staff.staffId === ADMIN_ID;
    return {
      access_token: token,
      token_type: "Bearer",
      expires_in: 900,
      storage: "memory_only",
      session: {
        session_id: admin ? ADMIN_SESSION_ID : APPROVER_SESSION_ID,
        session_version: sessionVersion,
        org_id: ORG_ID,
        store_id: STORE_ID,
        staff_id: staff.staffId,
        device_id: admin ? ADMIN_DEVICE_ID : APPROVER_DEVICE_ID,
        permission_version: 1,
      },
      role: "admin",
      features: { membership: true, accounting: true },
      display: {
        store_name: "ADR36 UAT Store",
        staff_name: staff.displayName,
        org_code: "local",
        store_code: "main",
      },
      ...(fakeOptions.extraAuthField === true ? { private_debug: "do-not-accept" } : {}),
    };
  };

  const accounting = (groupBy) => {
    const totals = financialComplete ? EXPECTED_DELTA : ZERO_BASIS;
    return {
      date_from: "2026-08-09",
      date_to: "2026-08-09",
      group_by: groupBy,
      totals,
      rows:
        groupBy === "staff" && financialComplete
          ? [{ key: ADMIN_ID, label: "ADR36 UAT Owner", ...totals }]
          : [],
    };
  };

  const accountView = () => ({
    account:
      account === null
        ? null
        : { ...account, balance_cents: account.principal_cents + account.bonus_cents },
    recent: [],
  });

  const visibleCatalog = () =>
    catalog === null || catalog.is_active !== true
      ? null
      : {
          code: catalog.code,
          name: catalog.name,
          service_code: catalog.service_code,
          category_code: catalog.category_code,
          unit_price_cents: catalog.unit_price_cents,
        };

  const respondAfterCommit = (name, response) => {
    const failureIndex = postCommitFailures.findIndex((failure) => failure.command === name);
    if (failureIndex === -1) return response;
    const [failure] = postCommitFailures.splice(failureIndex, 1);
    if (failure.kind === "bad-json") {
      return new Response(failure.privateBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (failure.kind === "network") throw new Error(failure.privateBody);
    assert.fail(`unexpected post-commit failure ${failure.kind}`);
  };

  const executeCommand = (name, args) => {
    if (name === "catalog.item.upsert") {
      const created = catalog === null;
      if (
        (created && args.expected_version !== undefined && args.expected_version !== 0) ||
        (!created &&
          args.expected_version !== undefined &&
          args.expected_version !== catalog.version)
      ) {
        return failure("IDEMPOTENCY_CONFLICT");
      }
      const action = created
        ? "created"
        : catalog.is_active === false && args.is_active === true
          ? "reactivated"
          : catalog.is_active === true && args.is_active === false
            ? "retired"
            : "updated";
      const version = created ? 1 : catalog.version + 1;
      catalog = {
        ...args,
        version,
        updated_at: 1_700_000_000 + version,
      };
      catalogAudits = Object.freeze([
        {
          id: `catalog-audit-${catalogAudits.length + 1}`,
          at_epoch_s: 1_700_000_000 + catalogAudits.length,
          staff_id: ADMIN_ID,
          action,
          codes: [args.code],
        },
        ...catalogAudits,
      ]);
      return success({ code: args.code, item: catalog, created, action });
    }
    if (name === "catalog.items.reorder") {
      const entry = args.items.find((item) => item.code === catalog?.code);
      if (
        catalog?.is_active !== true ||
        args.items.length !== 1 ||
        entry?.expected_version !== catalog.version
      ) {
        return failure("IDEMPOTENCY_CONFLICT");
      }
      const changed = catalog.sort_order !== 0;
      catalog = {
        ...catalog,
        sort_order: 0,
        version: changed ? catalog.version + 1 : catalog.version,
      };
      const action = changed ? "reordered" : "unchanged";
      catalogAudits = Object.freeze([
        {
          id: `catalog-audit-${catalogAudits.length + 1}`,
          at_epoch_s: 1_700_000_000 + catalogAudits.length,
          staff_id: ADMIN_ID,
          action,
          codes: [catalog.code],
        },
        ...catalogAudits,
      ]);
      return success({ items: [catalog], action });
    }
    if (name === "customer.upsert") {
      return success({
        customer_id: CUSTOMER_ID,
        phone: args.phone,
        name: args.name,
        created: true,
      });
    }
    if (name === "order.receive") {
      const index = orders.size;
      const paid = args.initial_payment?.amount_cents ?? 0;
      const order = {
        order_id: ORDER_IDS[index],
        status: "open",
        payable_cents: 2_600,
        paid_cents: paid,
        balance_cents: 2_600 - paid,
        garments: [
          { garment_id: GARMENT_IDS[index], barcode: `UATBARCODE${index}`, status: "received" },
        ],
      };
      orders.set(order.order_id, order);
      return success({ ...order, garment_count: 1 });
    }
    if (name === "garment.transition") {
      for (const order of orders.values()) {
        const garment = order.garments.find((row) => row.garment_id === args.garment_id);
        if (garment !== undefined) garment.status = args.target_status;
      }
      return success({ transitioned_count: 1 });
    }
    if (name === "garment.rack.assign") {
      for (const order of orders.values()) {
        const garment = order.garments.find((row) => row.barcode === args.barcode);
        if (garment !== undefined)
          Object.assign(garment, {
            status: "racked",
            rack_zone: args.rack_zone,
            rack_slot: args.rack_slot,
          });
      }
      return success({ status: "racked" });
    }
    if (name === "order.pickup") {
      const order = orders.get(args.order_id);
      const selected =
        args.garment_ids.length === 0
          ? order.garments
          : order.garments.filter((row) => args.garment_ids.includes(row.garment_id));
      for (const garment of selected) garment.status = "picked_up";
      order.paid_cents += args.collect_cents;
      order.balance_cents -= args.collect_cents;
      if (order.balance_cents === 0 && order.garments.every((row) => row.status === "picked_up"))
        order.status = "closed";
      return success({
        order_id: order.order_id,
        status: order.status,
        balance_cents: order.balance_cents,
      });
    }
    if (name === "member.bonus_rule.upsert") {
      bonusRule = { ...args, rule_id: args.rule_id ?? RULE_ID };
      return success(bonusRule);
    }
    if (name === "member.account.open") {
      account = {
        account_id: ACCOUNT_ID,
        customer_id: args.customer_id,
        status: "active",
        status_version: 1,
        principal_cents: 0,
        bonus_cents: 0,
      };
      return success({
        account_id: ACCOUNT_ID,
        customer_id: args.customer_id,
        status: "active",
        created: true,
      });
    }
    if (name === "member.topup") {
      account.principal_cents += args.amount_cents;
      account.bonus_cents += 1_000;
      return success({
        account_id: ACCOUNT_ID,
        principal_cents: account.principal_cents,
        bonus_cents: account.bonus_cents,
        balance_cents: account.principal_cents + account.bonus_cents,
      });
    }
    if (name === "member.balance.pay") {
      if (account.status === "frozen") {
        return jsonResponse(
          {
            ok: false,
            error: { code: "INVARIANT_FAILED", message: "sensitive frozen detail" },
          },
          409,
        );
      }
      const order = orders.get(args.order_id);
      const bonusUsed = Math.min(account.bonus_cents, args.amount_cents);
      account.bonus_cents -= bonusUsed;
      account.principal_cents -= args.amount_cents - bonusUsed;
      order.paid_cents += args.amount_cents;
      order.balance_cents -= args.amount_cents;
      return success({
        order_balance_cents: order.balance_cents,
        balance_cents: account.principal_cents + account.bonus_cents,
      });
    }
    if (name === "member.refund") {
      account.principal_cents -= args.amount_cents;
      return success({
        principal_cents: account.principal_cents,
        bonus_cents: account.bonus_cents,
        balance_cents: account.principal_cents + account.bonus_cents,
      });
    }
    if (name === "member.account.freeze" || name === "member.account.unfreeze") {
      account.status = name.endsWith("freeze") && !name.endsWith("unfreeze") ? "frozen" : "active";
      account.status_version += 1;
      return success({ ...account });
    }
    if (name === "member.account.close") {
      account = {
        ...account,
        status: "closed",
        status_version: account.status_version + 1,
        principal_cents: 0,
        bonus_cents: 0,
      };
      financialComplete = true;
      return success({ ...account, balance_cents: 0 });
    }
    assert.fail(`unexpected command ${name}`);
  };

  const executeQuery = (name, args) => {
    if (name === "accounting.report.get") return success(accounting(args.group_by));
    if (name === "catalog.items.get") return success({ item: visibleCatalog() });
    if (name === "catalog.items.list") {
      const item = visibleCatalog();
      return success({ items: item === null ? [] : [item], total: item === null ? 0 : 1 });
    }
    if (name === "catalog.items.manage.list") {
      const matches =
        catalog !== null && (args.query === undefined || catalog.code.includes(args.query));
      return success({ items: matches ? [catalog] : [], total: matches ? 1 : 0 });
    }
    if (name === "catalog.audit.list") {
      return success({
        items: catalogAudits
          .filter((item) => args.code === undefined || item.codes.includes(args.code))
          .slice(0, args.limit),
      });
    }
    if (name === "customer.search") return success({ customers: [] });
    if (name === "member.bonus_rules.list")
      return success({ rules: bonusRule === null ? [] : [bonusRule] });
    if (name === "member.account.get") return success(accountView());
    if (name === "order.get") return success({ ...orders.get(args.order_id) });
    if (name === "fulfillment.workbench") {
      const garments = [...orders.values()]
        .flatMap((order) => order.garments)
        .filter((row) => args.statuses.includes(row.status) && row.barcode === args.key);
      return success({ garments });
    }
    assert.fail(`unexpected query ${name}`);
  };

  const fetchImpl = async (url, options) => {
    const parsedUrl = new URL(url);
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    requests.push({ url: parsedUrl, options, body });
    assert.equal(parsedUrl.origin, ADR36_PUBLIC_ORIGIN);
    if (parsedUrl.pathname === "/api/v2/auth/login") {
      const staff = staffByUsername[body.username];
      assert.equal(body.password, staff.password);
      const cookies = authCookies(
        ++cookieSequence,
        false,
        fakeOptions.sameAuthCookieValue === true,
      );
      const data = authData(staff);
      return fakeOptions.loginBadJsonAfterCommit === true
        ? invalidJsonResponse("private committed login response", 200, cookies)
        : jsonResponse({ ok: true, data }, 200, cookies);
    }
    if (parsedUrl.pathname === "/api/v2/auth/refresh") {
      if (revokedCookieHeaders.has(options.headers.cookie)) {
        return jsonResponse(
          {
            ok: false,
            error: { code: "AUTHENTICATION_FAILED", message: "private revoked refresh detail" },
          },
          401,
          authCookies(++cookieSequence, true),
        );
      }
      const staff = options.headers.authorization.includes(ADMIN_ID)
        ? staffByUsername[env.LAUNDRY_BOOTSTRAP_ADMIN_USERNAME]
        : staffByUsername[env.LAUNDRY_BOOTSTRAP_APPROVER_USERNAME];
      return jsonResponse(
        {
          ok: true,
          data: authData(
            staff,
            fakeOptions.sameAccessTokenOnRefresh === true,
            fakeOptions.refreshSessionVersionDrift !== true,
          ),
        },
        200,
        authCookies(++cookieSequence, false, fakeOptions.sameAuthCookieValue === true),
      );
    }
    if (parsedUrl.pathname === "/api/v2/local/staff") {
      if (revokedAuthorizations.has(options.headers.authorization)) {
        return jsonResponse(
          {
            ok: false,
            error: { code: "AUTHENTICATION_FAILED", message: "private revoked bearer detail" },
          },
          401,
        );
      }
      return jsonResponse({
        ok: true,
        data: Object.entries(staffByUsername).map(([username, staff]) => ({
          username,
          staff_id: staff.staffId,
          display_name: staff.displayName,
          role: "admin",
          privacy_admin: true,
        })),
      });
    }
    if (parsedUrl.pathname === "/api/v2/auth/logout") {
      if (fakeOptions.ignoreLogoutRevocation !== true) {
        revokedAuthorizations.add(options.headers.authorization);
        revokedCookieHeaders.add(options.headers.cookie);
      }
      return jsonResponse(
        { ok: true, data: { logged_out: true } },
        200,
        authCookies(++cookieSequence, true),
      );
    }
    if (parsedUrl.pathname === "/api/v2/auth/pin/challenges") {
      const challengeId = `77777777-7777-4777-8777-${String(++challengeSequence).padStart(12, "0")}`;
      pending.set(challengeId, body.pending_action_ref);
      return jsonResponse({ ok: true, data: { challenge_id: challengeId } });
    }
    if (parsedUrl.pathname.endsWith("/verify")) {
      const expectedPin = env.LAUNDRY_BOOTSTRAP_APPROVER_PIN;
      assert.equal(body.pin, expectedPin);
      approved.add(pending.get(body.challenge_id));
      return jsonResponse({
        ok: true,
        data: {
          step_up_proof_id: fakeOptions.invalidStepUpProof
            ? "proof-not-a-uuid"
            : `99999999-9999-4999-8999-${String(challengeSequence).padStart(12, "0")}`,
        },
      });
    }
    if (parsedUrl.pathname.startsWith("/v1/queries/")) {
      return executeQuery(
        decodeURIComponent(parsedUrl.pathname.slice("/v1/queries/".length)),
        body,
      );
    }
    if (parsedUrl.pathname.startsWith("/v1/commands/")) {
      const name = decodeURIComponent(parsedUrl.pathname.slice("/v1/commands/".length));
      assert.equal(body.command, name);
      if (body.mode === "confirm") {
        const card = pending.get(body.confirm_ref);
        assert.equal(card.name, name);
        assert.equal(card.idempotencyKey, body.idempotency_key);
        if (card.stepUp) assert.ok(approved.has(body.confirm_ref));
        return respondAfterCommit(name, executeCommand(name, card.args));
      }
      const gated = [
        "member.bonus_rule.upsert",
        "member.topup",
        "member.refund",
        "member.account.freeze",
        "member.account.unfreeze",
        "member.account.close",
      ];
      if (gated.includes(name)) {
        const confirmRef = `88888888-8888-4888-8888-${String(++pendingSequence).padStart(12, "0")}`;
        const stepUp = name === "member.refund" || name === "member.account.close";
        pending.set(confirmRef, {
          name,
          args: body.args,
          idempotencyKey: body.idempotency_key,
          stepUp,
        });
        return gate(
          stepUp ? "POLICY_STEP_UP_REQUIRED" : "POLICY_CONFIRMATION_REQUIRED",
          confirmRef,
        );
      }
      return respondAfterCommit(name, executeCommand(name, body.args));
    }
    assert.fail(`unexpected path ${parsedUrl.pathname}`);
  };
  return Object.freeze({ fetchImpl, requests });
}

const TEST_EXTENSIONS = Object.freeze({
  createStaffJourney: () =>
    Object.freeze({
      execute: async () => {},
      cleanup: async () => true,
    }),
  orderFinanceJourney: async () => {},
  reportingJourney: async () => {},
  cleanupOrderFinance: async () => true,
});

export {
  ADMIN_ID,
  TEST_EXTENSIONS,
  acceptanceEnvironment,
  authCookies,
  createFakeCloud,
  jsonResponse,
  sequentialUuid,
};
