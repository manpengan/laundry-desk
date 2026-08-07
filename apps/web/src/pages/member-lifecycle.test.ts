import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { FULL_STORE_FEATURES } from "../auth/permissions.js";
import type { SessionView } from "../auth/types.js";
import { createMockCommandClient } from "../commands/command-client.js";
import { MemberLifecyclePanel, memberLifecycleDisplaySnapshot } from "./MemberLifecyclePanel.js";
import {
  buildMemberLifecycleBody,
  normalizeMemberLifecycleReason,
  resumeMemberLifecycle,
} from "./member-lifecycle.js";
import type { MemberAccountSummary } from "./member-model.js";

const CUSTOMER = Object.freeze({
  customer_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  phone: "13800000123",
  name: "生命周期顾客",
  note: null,
  updated_at: 1_754_000_000,
});

const ACCOUNT: MemberAccountSummary = Object.freeze({
  account_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  customer_id: CUSTOMER.customer_id,
  status: "active",
  status_version: 3,
  status_changed_at: null,
  status_reason: null,
  principal_cents: 10_000,
  bonus_cents: 1_000,
  balance_cents: 11_000,
});

function session(role: "admin" | "staff"): SessionView {
  return Object.freeze({
    session: Object.freeze({
      session_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      session_version: 1,
      org_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      store_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      staff_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      device_id: "11111111-1111-4111-8111-111111111111",
      permission_version: 1,
    }),
    role,
    features: FULL_STORE_FEATURES,
    display: Object.freeze({
      store_name: "本地店",
      staff_name: role === "admin" ? "店长" : "店员",
      org_code: "ORG",
      store_code: "S1",
    }),
  });
}

test("lifecycle bodies freeze customer/version and close money snapshot", () => {
  assert.deepEqual(buildMemberLifecycleBody("freeze", ACCOUNT, "  顾客报失  ", "cash"), {
    account_id: ACCOUNT.account_id,
    expected_customer_id: ACCOUNT.customer_id,
    expected_status_version: 3,
    reason: "顾客报失",
  });
  assert.deepEqual(buildMemberLifecycleBody("close", ACCOUNT, "顾客退卡", "wechat"), {
    account_id: ACCOUNT.account_id,
    expected_customer_id: ACCOUNT.customer_id,
    expected_status_version: 3,
    reason: "顾客退卡",
    expected_status: "active",
    expected_principal_cents: 10_000,
    expected_bonus_cents: 1_000,
    refund_tender: "wechat",
  });
  assert.deepEqual(
    buildMemberLifecycleBody(
      "close",
      { ...ACCOUNT, principal_cents: 0, balance_cents: 1_000 },
      "仅作废赠款",
      "cash",
    ),
    {
      account_id: ACCOUNT.account_id,
      expected_customer_id: ACCOUNT.customer_id,
      expected_status_version: 3,
      reason: "仅作废赠款",
      expected_status: "active",
      expected_principal_cents: 0,
      expected_bonus_cents: 1_000,
      refund_tender: null,
    },
  );
});

test("lifecycle body builder refuses bad reasons and invalid transitions", () => {
  assert.equal(normalizeMemberLifecycleReason(" "), null);
  assert.equal(normalizeMemberLifecycleReason("x".repeat(257)), null);
  assert.equal(buildMemberLifecycleBody("unfreeze", ACCOUNT, "状态不匹配", "cash"), null);
  assert.equal(
    buildMemberLifecycleBody(
      "freeze",
      { ...ACCOUNT, status: "closed", principal_cents: 0, bonus_cents: 0, balance_cents: 0 },
      "终态",
      "cash",
    ),
    null,
  );
});

test("close confirmation display reads status and money only from its frozen body", () => {
  const body = buildMemberLifecycleBody("close", ACCOUNT, "顾客退卡", "wechat");
  assert.notEqual(body, null);
  if (body === null) return;
  const pending = Object.freeze({
    action: "close" as const,
    command: "member.account.close" as const,
    body,
    confirmRef: "22222222-2222-4222-8222-222222222222",
    gate: "step_up" as const,
  });
  assert.deepEqual(
    memberLifecycleDisplaySnapshot(pending, {
      ...ACCOUNT,
      status: "frozen",
      principal_cents: 1,
      bonus_cents: 2,
      balance_cents: 3,
    }),
    { status: "active", balanceCents: 11_000 },
  );
});

test("all lifecycle continuation hops send an empty body plus frozen confirm_ref", async () => {
  const calls: { name: string; body: unknown; confirmRef?: string }[] = [];
  const client = createMockCommandClient(
    async <T = unknown>(
      name: string,
      body: unknown = {},
      options: Readonly<{ confirmRef?: string }> = {},
    ) => {
      calls.push({
        name,
        body,
        ...(options.confirmRef === undefined ? {} : { confirmRef: options.confirmRef }),
      });
      return Object.freeze({ ok: true as const, data: Object.freeze({}) as T });
    },
  );
  await resumeMemberLifecycle(client, "member.account.freeze", "freeze-ref");
  await resumeMemberLifecycle(client, "member.account.unfreeze", "unfreeze-ref");
  await resumeMemberLifecycle(client, "member.account.close", "close-ref");
  assert.deepEqual(calls, [
    { name: "member.account.freeze", body: {}, confirmRef: "freeze-ref" },
    { name: "member.account.unfreeze", body: {}, confirmRef: "unfreeze-ref" },
    { name: "member.account.close", body: {}, confirmRef: "close-ref" },
  ]);
});

function renderPanel(account: MemberAccountSummary, role: "admin" | "staff"): string {
  return renderToStaticMarkup(
    createElement(MemberLifecyclePanel, {
      customer: CUSTOMER,
      account,
      commandClient: createMockCommandClient(),
      session: session(role),
      toast: { push: () => undefined },
      onCompleted: async () => undefined,
    }),
  );
}

test("staff can freeze an active account but cannot manage or close it", () => {
  const html = renderPanel(ACCOUNT, "staff");
  assert.match(html, /data-testid="member-freeze"/u);
  assert.doesNotMatch(html, /data-testid="member-unfreeze"/u);
  assert.doesNotMatch(html, /data-testid="member-close"/u);
});

test("admin can unfreeze or close a frozen account", () => {
  const html = renderPanel(
    {
      ...ACCOUNT,
      status: "frozen",
      status_version: 4,
      status_changed_at: 1_754_000_100,
      status_reason: "顾客报失",
    },
    "admin",
  );
  assert.doesNotMatch(html, /data-testid="member-freeze"/u);
  assert.match(html, /data-testid="member-unfreeze"/u);
  assert.match(html, /data-testid="member-close"/u);
});

test("closed accounts expose no lifecycle mutation surface", () => {
  const html = renderPanel(
    {
      ...ACCOUNT,
      status: "closed",
      status_version: 5,
      status_changed_at: 1_754_000_200,
      status_reason: "顾客退卡",
      principal_cents: 0,
      bonus_cents: 0,
      balance_cents: 0,
    },
    "admin",
  );
  assert.equal(html, "");
});
