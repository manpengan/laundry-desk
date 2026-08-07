import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { ToastProvider } from "@laundry/ui";

import { createMockAuthClient } from "../auth/AuthClient.js";
import { FULL_STORE_FEATURES } from "../auth/permissions.js";
import type { SessionView } from "../auth/types.js";
import { createMockCommandClient } from "../commands/command-client.js";
import type { QueryPort } from "../commands/types.js";
import { MemberBonusRulesPanel, resumeMemberBonusRule } from "./MemberBonusRulesPanel.js";
import { MemberRefundForm, resumeMemberRefund } from "./MemberRefundForm.js";

const ADMIN_SESSION: SessionView = Object.freeze({
  session: Object.freeze({
    session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    session_version: 1,
    org_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    store_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    staff_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    device_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    permission_version: 1,
  }),
  role: "admin",
  features: FULL_STORE_FEATURES,
  display: Object.freeze({
    store_name: "本地店",
    staff_name: "店长",
    org_code: "ORG",
    store_code: "S1",
  }),
});

const QUERY: QueryPort = Object.freeze({
  execute: async <T = unknown>() =>
    Object.freeze({ ok: true as const, data: Object.freeze({ result: { rules: [] } }) as T }),
});

test("ADR-22 settings surface exposes tier fields and authority copy", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(MemberBonusRulesPanel, {
        commandClient: createMockCommandClient(),
        queryClient: QUERY,
      }),
    ),
  );
  assert.match(html, /充值赠送/);
  assert.match(html, /充满（元）/);
  assert.match(html, /赠送（元）/);
  assert.match(html, /不重估历史流水/);
});

test("ADR-22 refund surface shows refundable principal and step-up copy for admins", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(MemberRefundForm, {
        accountId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        accountStatus: "active",
        refundableCents: 100_000,
        commandClient: createMockCommandClient(),
        authClient: createMockAuthClient(),
        session: ADMIN_SESSION,
        toast: { push: () => undefined },
        onCompleted: async () => undefined,
      }),
    ),
  );
  assert.match(html, /退还储值本金/);
  assert.match(html, /赠款不退现/);
  assert.match(html, /另一位管理员现场 PIN 复核/);
});

test("ordinary member refund is hidden while the account is frozen", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(MemberRefundForm, {
        accountId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        accountStatus: "frozen",
        refundableCents: 100_000,
        commandClient: createMockCommandClient(),
        authClient: createMockAuthClient(),
        session: ADMIN_SESSION,
        toast: { push: () => undefined },
        onCompleted: async () => undefined,
      }),
    ),
  );
  assert.doesNotMatch(html, /data-testid="member-refund"/);
});

test("ADR-22 confirmations resume with only the frozen confirm_ref", async () => {
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
  await resumeMemberBonusRule(client, "rule-ref");
  await resumeMemberRefund(client, "refund-ref");
  assert.deepEqual(calls, [
    { name: "member.bonus_rule.upsert", body: {}, confirmRef: "rule-ref" },
    { name: "member.refund", body: {}, confirmRef: "refund-ref" },
  ]);
});
