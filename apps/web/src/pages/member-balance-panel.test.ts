import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { createMockCommandClient } from "../commands/command-client.js";
import { requestMemberTopup, resumeMemberTopup } from "./MemberBalancePanel.js";
import { MemberTopupConfirmation } from "./MemberTopupConfirmation.js";

const TOPUP = Object.freeze({
  account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  amount_cents: 5_000,
  method: "cash",
});

test("member top-up pauses for explicit R3 confirmation, then resumes with ref only", async () => {
  const calls: { name: string; body: unknown; confirmRef?: string }[] = [];
  const confirmRef = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const commandClient = createMockCommandClient(
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
      if (options.confirmRef === undefined) {
        return Object.freeze({
          ok: false as const,
          error: Object.freeze({
            code: "POLICY_CONFIRMATION_REQUIRED",
            detail: Object.freeze({ kind: "confirmation", confirm_ref: confirmRef }),
          }),
        });
      }
      return Object.freeze({
        ok: true as const,
        data: Object.freeze({ topped_up: true }) as T,
      });
    },
  );

  const requested = await requestMemberTopup(commandClient, TOPUP);
  assert.equal(requested.ok, false);
  assert.deepEqual(calls, [{ name: "member.topup", body: TOPUP }]);
  assert.equal((await resumeMemberTopup(commandClient, confirmRef)).ok, true);
  assert.deepEqual(calls, [
    { name: "member.topup", body: TOPUP },
    { name: "member.topup", body: {}, confirmRef },
  ]);
});

test("member top-up does not retry a non-confirmation failure", async () => {
  let calls = 0;
  const commandClient = createMockCommandClient(async () => {
    calls += 1;
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({ code: "MEMBER_ACCOUNT_FROZEN", message: "账户已冻结" }),
    });
  });

  const result = await requestMemberTopup(commandClient, TOPUP);
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
});

test("member top-up leaves a manager step-up pending instead of bypassing it", async () => {
  let calls = 0;
  const commandClient = createMockCommandClient(async () => {
    calls += 1;
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({
        code: "POLICY_STEP_UP_REQUIRED",
        detail: Object.freeze({
          kind: "confirmation",
          confirm_ref: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        }),
      }),
    });
  });

  const result = await requestMemberTopup(commandClient, TOPUP);
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
});

test("member top-up confirmation renders only the server-frozen money and matched tier", () => {
  const html = renderToStaticMarkup(
    createElement(MemberTopupConfirmation, {
      method: "cash",
      summary: Object.freeze({
        kind: "member_topup",
        principal_cents: 100_000,
        bonus_cents: 10_000,
        credited_cents: 110_000,
        matched_rule: Object.freeze({
          rule_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          min_topup_cents: 100_000,
          bonus_cents: 10_000,
        }),
      }),
    }),
  );

  assert.match(html, /充值本金/u);
  assert.match(html, /赠送/u);
  assert.match(html, /到账/u);
  assert.match(html, /命中档位/u);
  assert.match(html, /收款渠道：现金/u);
  assert.doesNotMatch(html, /按服务端当前有效档位计算/u);
});
