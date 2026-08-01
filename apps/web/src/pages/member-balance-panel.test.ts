import assert from "node:assert/strict";
import test from "node:test";

import { createMockCommandClient } from "../commands/command-client.js";
import { executeMemberTopup } from "./MemberBalancePanel.js";

const TOPUP = Object.freeze({
  account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  amount_cents: 5_000,
  method: "cash",
});

test("member top-up resumes the R3 confirmation using only the frozen confirm_ref", async () => {
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

  assert.equal((await executeMemberTopup(commandClient, TOPUP)).ok, true);
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

  const result = await executeMemberTopup(commandClient, TOPUP);
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

  const result = await executeMemberTopup(commandClient, TOPUP);
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
});
