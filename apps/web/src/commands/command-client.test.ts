import assert from "node:assert/strict";
import test from "node:test";

import {
  createHttpCommandClient,
  createMockCommandClient,
  isStepUpRequired,
} from "./command-client.js";

test("isStepUpRequired detects POLICY_STEP_UP_REQUIRED + confirm_ref", () => {
  assert.equal(
    isStepUpRequired({
      ok: false,
      error: {
        code: "POLICY_STEP_UP_REQUIRED",
        detail: { kind: "confirmation", confirm_ref: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
      },
    }),
    true,
  );
  assert.equal(
    isStepUpRequired({
      ok: false,
      error: { code: "POLICY_DENIED" },
    }),
    false,
  );
  assert.equal(isStepUpRequired({ ok: true, data: {} }), false);
});

test("HTTP command client posts confirm_ref only on resume hop", async () => {
  const calls: Array<{ url: string; body: string; idempotencyKey: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: String(init?.body ?? ""),
      idempotencyKey: new Headers(init?.headers).get("idempotency-key"),
    });
    return new Response(JSON.stringify({ ok: true, data: { saved: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createHttpCommandClient({
    apiBaseUrl: "http://127.0.0.1:8787",
    getAccessToken: () => "tok",
    readCsrf: () => "csrf-token",
    newIdempotencyKey: () => "10000000-0000-4000-8000-000000000001",
    fetchImpl,
  });
  const result = await client.execute(
    "platform.settings.set",
    { entries: [] },
    { confirmRef: "ref-1" },
  );
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/v1\/commands\/platform\.settings\.set$/u);
  assert.equal(calls[0]!.body, JSON.stringify({ confirm_ref: "ref-1" }));
  assert.equal(calls[0]!.idempotencyKey, "10000000-0000-4000-8000-000000000001");
});

test("HTTP command retries reuse one key until a definitive response arrives", async () => {
  const keys: Array<string | null> = [];
  let calls = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    keys.push(new Headers(init?.headers).get("idempotency-key"));
    calls += 1;
    if (calls === 1) throw new TypeError("response lost");
    return new Response(JSON.stringify({ ok: true, data: { saved: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const generated = [
    "10000000-0000-4000-8000-000000000011",
    "10000000-0000-4000-8000-000000000012",
  ];
  const client = createHttpCommandClient({
    apiBaseUrl: "http://127.0.0.1:8787",
    getAccessToken: () => "tok",
    readCsrf: () => "csrf-token",
    newIdempotencyKey: () => generated.shift()!,
    fetchImpl,
  });
  const body = { asset: { asset_kind: "punch", asset_id: "asset", uses: 1 }, reason: "洗衣" };
  assert.equal((await client.execute("member.asset.consume", body)).ok, false);
  assert.equal((await client.execute("member.asset.consume", body)).ok, true);
  assert.equal((await client.execute("member.asset.consume", body)).ok, true);
  assert.deepEqual(keys, [
    "10000000-0000-4000-8000-000000000011",
    "10000000-0000-4000-8000-000000000011",
    "10000000-0000-4000-8000-000000000012",
  ]);
});

test("HTTP command retries reuse one key after a structured uncertain server failure", async () => {
  const keys: Array<string | null> = [];
  let calls = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    keys.push(new Headers(init?.headers).get("idempotency-key"));
    calls += 1;
    const body =
      calls === 1
        ? { ok: false, error: { code: "TRANSACTION_FAILED", message: "命令事务失败" } }
        : { ok: true, data: { remaining_uses: calls === 2 ? 2 : 1 } };
    return new Response(JSON.stringify(body), {
      status: calls === 1 ? 500 : 200,
      headers: { "content-type": "application/json" },
    });
  };
  const generated = [
    "10000000-0000-4000-8000-000000000031",
    "10000000-0000-4000-8000-000000000032",
  ];
  const client = createHttpCommandClient({
    apiBaseUrl: "http://127.0.0.1:8787",
    getAccessToken: () => "tok",
    readCsrf: () => "csrf-token",
    newIdempotencyKey: () => generated.shift()!,
    fetchImpl,
  });
  const body = { asset: { asset_kind: "punch", asset_id: "asset", uses: 1 }, reason: "洗衣" };

  assert.equal((await client.execute("member.asset.consume", body)).ok, false);
  assert.equal((await client.execute("member.asset.consume", body)).ok, true);
  assert.equal((await client.execute("member.asset.consume", body)).ok, true);
  assert.deepEqual(keys, [
    "10000000-0000-4000-8000-000000000031",
    "10000000-0000-4000-8000-000000000031",
    "10000000-0000-4000-8000-000000000032",
  ]);
});

test("HTTP confirmation resumes with the first hop idempotency key", async () => {
  const keys: Array<string | null> = [];
  let calls = 0;
  const confirmRef = "20000000-0000-4000-8000-000000000001";
  const fetchImpl: typeof fetch = async (_input, init) => {
    keys.push(new Headers(init?.headers).get("idempotency-key"));
    calls += 1;
    const body =
      calls === 1
        ? {
            ok: false,
            error: { code: "POLICY_CONFIRMATION_REQUIRED", detail: { confirm_ref: confirmRef } },
          }
        : { ok: true, data: { saved: true } };
    return new Response(JSON.stringify(body), {
      status: calls === 1 ? 403 : 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createHttpCommandClient({
    apiBaseUrl: "http://127.0.0.1:8787",
    getAccessToken: () => "tok",
    readCsrf: () => "csrf-token",
    newIdempotencyKey: () => "10000000-0000-4000-8000-000000000021",
    fetchImpl,
  });
  const first = await client.execute("order.cancel", { order_id: "order", reason: "取消" });
  assert.equal(isStepUpRequired(first), true);
  assert.equal((await client.execute("order.cancel", {}, { confirmRef })).ok, true);
  assert.deepEqual(keys, [
    "10000000-0000-4000-8000-000000000021",
    "10000000-0000-4000-8000-000000000021",
  ]);
});

test("HTTP command client preserves the validated member top-up confirmation summary", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        ok: false,
        error: {
          code: "POLICY_CONFIRMATION_REQUIRED",
          message: "Confirmation is required",
          detail: {
            kind: "confirmation",
            confirm_ref: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            summary: {
              kind: "member_topup",
              principal_cents: 100_000,
              bonus_cents: 10_000,
              credited_cents: 110_000,
              matched_rule: {
                rule_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
                min_topup_cents: 100_000,
                bonus_cents: 10_000,
              },
            },
          },
        },
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  const client = createHttpCommandClient({
    apiBaseUrl: "http://127.0.0.1:8787",
    getAccessToken: () => "tok",
    readCsrf: () => "csrf-token",
    fetchImpl,
  });

  const result = await client.execute("member.topup", {
    account_id: "11111111-1111-4111-8111-111111111111",
    amount_cents: 100_000,
    method: "cash",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.error.detail?.summary, {
    kind: "member_topup",
    principal_cents: 100_000,
    bonus_cents: 10_000,
    credited_cents: 110_000,
    matched_rule: {
      rule_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      min_topup_cents: 100_000,
      bonus_cents: 10_000,
    },
  });
});

test("HTTP command client preserves the server-bound notification target summary", async () => {
  const summary = {
    kind: "notification_delivery_batch" as const,
    order_count: 2,
    risk_window_order_count: 11,
    ticket_nos: ["OUTBOX-001", "OUTBOX-002"],
    channel: "sms" as const,
    assurance: "software_only" as const,
    provider_code: "software_only_fake",
    template_code: "pickup_reminder_v1" as const,
    template_version: 1,
    estimated_cost_cents: 0,
    max_cost_cents: 0,
    min_age_days: 30 as const,
    unpaid_only: true,
    garment_statuses: ["racked" as const],
  };
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        ok: false,
        error: {
          code: "POLICY_STEP_UP_REQUIRED",
          message: "Step-up verification is required",
          detail: {
            kind: "confirmation",
            confirm_ref: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            summary,
          },
        },
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  const client = createHttpCommandClient({
    apiBaseUrl: "http://127.0.0.1:8787",
    getAccessToken: () => "tok",
    readCsrf: () => "csrf-token",
    fetchImpl,
  });
  const result = await client.execute("notification.delivery_batch.enqueue", {
    order_ids: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
    channel: "sms",
    template_code: "pickup_reminder_v1",
    max_cost_cents: 0,
    min_age_days: 30,
    unpaid_only: true,
    garment_statuses: ["racked"],
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.error.detail?.summary, summary);
});

test("mock command client returns injectable step-up gate", async () => {
  const client = createMockCommandClient();
  const result = await client.execute("platform.settings.set", {});
  assert.equal(isStepUpRequired(result), true);
});
