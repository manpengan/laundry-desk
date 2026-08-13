import assert from "node:assert/strict";
import test from "node:test";

import { createHttpApprovalPort } from "./approval-port.js";

const APPROVAL = "11111111-1111-4111-8111-111111111111";
const CONFIRM = "22222222-2222-4222-8222-222222222222";
const REQUESTER = "33333333-3333-4333-8333-333333333333";
const IDEMPOTENCY = "44444444-4444-4444-8444-444444444444";

const view = Object.freeze({
  approval_ref: APPROVAL,
  confirm_ref: CONFIRM,
  command: "payment.refund",
  command_version: "1.0.0",
  args: Object.freeze({ payment_id: IDEMPOTENCY, amount_cents: 100 }),
  args_hash: "a".repeat(64),
  entity_versions: Object.freeze([]),
  idempotency_key: IDEMPOTENCY,
  requester_staff_id: REQUESTER,
  status: "pending" as const,
  row_version: 1,
  created_at_epoch: 1,
  expires_at_epoch: 2,
  decided_by_staff_id: null,
  decided_by_permission_version: null,
  decided_at_epoch: null,
  decision_reason: null,
  consumed_at_epoch: null,
});

test("browser approval port keeps auth private and sends only CAS decision input", async () => {
  const calls: Array<Readonly<{ url: string; init: RequestInit }>> = [];
  const port = createHttpApprovalPort({
    apiBaseUrl: "https://desk.example.test/",
    getAccessToken: () => "private.token.value",
    readCsrf: () => "csrf-proof",
    fetchImpl: async (input, init = {}) => {
      calls.push(Object.freeze({ url: String(input), init }));
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            approval: { ...view, status: "consumed", row_version: 3 },
            execution: "executed",
            result: {},
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const result = await port.approve(APPROVAL, 1);
  assert.equal(result.ok, true);
  const call = calls[0];
  assert.ok(call);
  assert.equal(
    call.url,
    `https://desk.example.test/api/v2/ai/approval-requests/${APPROVAL}/approve`,
  );
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get("authorization"), "Bearer private.token.value");
  assert.equal(headers.get("x-csrf-token"), "csrf-proof");
  assert.deepEqual(JSON.parse(String(call.init.body)), { expected_version: 1 });
  assert.doesNotMatch(call.url, /private\.token|csrf-proof/u);
});

test("browser approval port validates full authority views and forwards AbortSignal", async () => {
  let observedSignal: AbortSignal | null | undefined;
  const abort = new AbortController();
  const port = createHttpApprovalPort({
    apiBaseUrl: "https://desk.example.test",
    getAccessToken: () => "private.token.value",
    readCsrf: () => "csrf-proof",
    fetchImpl: async (_input, init) => {
      observedSignal = init?.signal;
      return new Response(
        JSON.stringify({ ok: true, data: { items: [{ ...view, args_hash: "bad" }] } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  const result = await port.list("pending", abort.signal);
  assert.equal(observedSignal, abort.signal);
  assert.deepEqual(result, {
    ok: false,
    error: { code: "SERVICE_UNAVAILABLE", message: "审批服务响应格式错误" },
  });
});
