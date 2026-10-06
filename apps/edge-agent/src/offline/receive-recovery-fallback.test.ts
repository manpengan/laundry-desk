import assert from "node:assert/strict";
import test from "node:test";

import { createCommandError } from "@laundry/contracts";

import type { DesktopHttpTransport } from "../desktop/http-transport.js";
import type { OfflineCommandRuntime } from "./runtime.js";
import { createOfflineReceiveRecovery } from "./receive-recovery-fallback.js";

const key = "77777777-7777-4777-8777-777777777777";
const unanswered = { ok: false, error: { code: "RECOVERY_UNAVAILABLE", message: "未确认" } };
const queued = { ok: true, data: { execution: "executed", result: { offline_queued: true } } };
const handedOver = { ok: true, data: { draft: null, pending_body: null, receipt: queued } };
const submit = { operation: "submit", operation_id: key, body: { customer_phone: "1" } };

function fixture(healthOk: boolean, readOnly = false) {
  const queuedWith: unknown[] = [];
  const online = {
    receiveRecovery: {
      execute: async () => unanswered,
      queueOffline: async (
        _input: unknown,
        queue: (body: Readonly<Record<string, unknown>>, idempotencyKey: string) => unknown,
      ) => {
        await queue({ customer_phone: "1" }, key);
        return handedOver;
      },
    },
    health: {
      get: async () =>
        healthOk
          ? { ok: true, data: { status: "ready" } }
          : { ok: false, error: createCommandError("RESOURCE_UNAVAILABLE") },
    },
  } as unknown as DesktopHttpTransport;
  const offline = {
    queueCommand: async (input: unknown, options: unknown) => {
      queuedWith.push([input, options]);
      return queued;
    },
  } as unknown as OfflineCommandRuntime;
  return { recovery: createOfflineReceiveRecovery(online, offline, () => readOnly), queuedWith };
}

test("an unanswered receive stays with its original key while the service still answers", async () => {
  const { recovery, queuedWith } = fixture(true);
  assert.deepEqual(await recovery.execute(submit), unanswered);
  assert.deepEqual(queuedWith, []);
});

test("an unanswered receive goes to the offline queue under its own key while the service is down", async () => {
  const { recovery, queuedWith } = fixture(false);
  assert.deepEqual(await recovery.execute(submit), handedOver);
  assert.deepEqual(queuedWith, [
    [{ name: "order.receive", body: { customer_phone: "1" } }, { idempotencyKey: key }],
  ]);
  // A load or save is never treated as an unanswered submission.
  assert.deepEqual(await recovery.execute({ operation: "load" }), unanswered);
  assert.equal(queuedWith.length, 1);
});

test("read-only recovery never reaches the server or the queue", async () => {
  const { recovery, queuedWith } = fixture(false, true);
  const result = await recovery.execute(submit);
  assert.equal(Reflect.get(result as object, "ok"), false);
  assert.deepEqual(queuedWith, []);
});
