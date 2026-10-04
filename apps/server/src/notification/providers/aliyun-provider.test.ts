import assert from "node:assert/strict";
import test from "node:test";
import type { NotificationProviderSettings } from "@laundry/contracts";
import type { AliyunSmsSendInput, AliyunSmsSendResult } from "./aliyun-client.js";
import { createAliyunNotificationProvider } from "./aliyun-provider.js";
import type { createAliyunSmsClient } from "./aliyun-client.js";

const settings: NotificationProviderSettings = {
  version: 1,
  enabled: true,
  provider: "aliyun_sms",
  sign_name: "合成门店",
  template_code: "SMS_123456",
  unit_cost_cents: 5,
  max_batch_cost_cents: 500,
};
function provider(result: AliyunSmsSendResult) {
  const sent: AliyunSmsSendInput[] = [];
  const client = {
    async send(input: AliyunSmsSendInput) {
      sent.push(input);
      return result;
    },
    async query() {
      return "unknown" as const;
    },
  } as unknown as ReturnType<typeof createAliyunSmsClient>;
  return { sent, provider: createAliyunNotificationProvider(settings, client, async () => true) };
}
const send = (target: ReturnType<typeof provider>["provider"]) =>
  target.send({
    deliveryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    recipient: "13900000000",
    message: "local preview",
    parameters: { tickets: "TEST-001", garment_count: "2", balance_cents: "2000" },
    timeoutMs: 1_000,
    deadline: new Date(Date.now() + 1_000),
    signal: new AbortController().signal,
  });

test("the approved template receives the balance in 元, never in 分", async () => {
  const f = provider({ status: "accepted", bizId: "biz" });
  assert.deepEqual(await send(f.provider), {
    outcome: "accepted",
    errorCode: null,
    providerRef: "biz",
    costCents: 5,
  });
  assert.deepEqual(f.sent[0]?.parameters, {
    tickets: "TEST-001",
    garment_count: "2",
    balance_yuan: "20.00",
  });
});

test("unsent and refused messages end with their reason; only ambiguity stays uncertain", async () => {
  for (const [result, outcome] of [
    [{ status: "not_sent", code: "ALIYUN_NOT_SENT" }, "permanent_failure"],
    [{ status: "rejected", code: "ALIYUN_ACCESS_KEY_INVALID" }, "permanent_failure"],
    [{ status: "uncertain", code: "ALIYUN_OUTCOME_UNKNOWN" }, "uncertain"],
  ] as const) {
    const f = provider(result);
    assert.deepEqual(await send(f.provider), {
      outcome,
      errorCode: result.code,
      providerRef: null,
      costCents: 0,
    });
  }
});
