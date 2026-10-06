import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  DesktopReceiveRecoveryInputSchema,
  ReceiveRecoveryDraftSchema,
  type DesktopReceiveRecoveryInput,
  type DesktopReceiveRecoveryResult,
  type ReceiveRecoverySnapshot,
} from "@laundry/contracts";
import type { CommandPort, CommandResult, QueryPort } from "../commands/types.js";
import type { ReceiveRecoveryPort } from "../host/receive-recovery-port.js";
import { createReceiveWorkspace } from "./receive-workspace.js";
import { connectReceiveRecovery } from "./receive-recovery.js";
import { submitReceive } from "./receive-submission.js";

const operationId = "11111111-1111-4111-8111-111111111111";
const orderId = "22222222-2222-4222-8222-222222222222";
const expected = { session_id: "33333333-3333-4333-8333-333333333333", session_version: 7 };
const original = {
  order_id: orderId,
  ticket_no: "20261006-0001",
  pickup_code: "P0001",
  payable_cents: 1000,
  paid_cents: 0,
  balance_cents: 1000,
  discount_cents: 0,
  discount_source: "none" as const,
  discount_bps: 0,
  waivers: { skip_ticket_print: true, skip_label_print: true, skip_rack_assignment: true },
  garment_count: 0,
  garments: [],
};
const body = {
  lines: [{ service_code: "wash", category_code: "coat", qty: 1 }],
  initial_payment: { amount_cents: 1000, method: "cash" as const },
};
const empty = (): ReceiveRecoverySnapshot => ({ draft: null, pending_body: null, receipt: null });
type ReceiverReceipt = NonNullable<ReceiveRecoverySnapshot["receipt"]>;
const offlineReceipt: ReceiverReceipt = {
  ok: true,
  data: {
    execution: "executed",
    result: { ...body, offline_queued: true, queue_id: "44444444-4444-4444-8444-444444444444" },
  },
};
const noOrderRead: QueryPort = {
  execute: async () => {
    throw new Error("A queued receive has no order to read back yet");
  },
};
test("an unresolved desktop operation cannot be reset into a different identity", () => {
  const store = createReceiveWorkspace();
  store.patch({
    operationId,
    phase: "uncertain",
    recoveryStatus: "ready",
    pendingBody: body,
    phone: "13800000999",
  });
  const original = store.getSnapshot();
  store.reset();
  assert.equal(store.getSnapshot(), original);
  store.patch({ phase: "complete" });
  store.reset();
  assert.notEqual(store.getSnapshot().operationId, operationId);
});
const fixtureDraft = () => {
  const state = createReceiveWorkspace().getSnapshot();
  return ReceiveRecoveryDraftSchema.parse({
    operationId,
    phone: "13800000999",
    name: "恢复测试",
    paymentCents: "1000",
    paymentMethod: "cash",
    pricing: state.pricing,
    note: "原备注",
    draftId: null,
    lines: state.lines,
    dirty: true,
  });
};
const query: QueryPort = {
  async execute<T>(): Promise<CommandResult<T>> {
    return {
      ok: true,
      data: { ...original, status: "open", paid_cents: 1000, balance_cents: 0, lines: [] } as T,
    };
  },
};
const noFallback: CommandPort = {
  execute: async () => {
    throw new Error("Recovered receive must not use the generic command port");
  },
};
function fixture(
  initial = empty(),
  submitted: ReceiverReceipt = { ok: true, data: { execution: "executed", result: original } },
) {
  let snapshot = structuredClone(initial);
  let rejectSave = false;
  const inputs: DesktopReceiveRecoveryInput[] = [];
  const port: ReceiveRecoveryPort = {
    async execute(input) {
      inputs.push(structuredClone(input));
      if (input.operation === "save") {
        if (rejectSave)
          return { ok: false, error: { code: "RECOVERY_UNAVAILABLE", message: "磁盘写入失败" } };
        snapshot = { ...snapshot, draft: structuredClone(input.draft) };
      }
      if (input.operation === "submit")
        snapshot = { ...snapshot, pending_body: input.body, receipt: structuredClone(submitted) };
      return { ok: true, data: structuredClone(snapshot) };
    },
  };
  return {
    port,
    inputs,
    reject: () => {
      rejectSave = true;
    },
  };
}

test("unfinished encrypted draft restores with the same operation and no live scale reading", async () => {
  const h = fixture({ ...empty(), draft: fixtureDraft() });
  const store = createReceiveWorkspace();
  const stop = connectReceiveRecovery(store, h.port, expected, query);
  assert.equal(store.begin(), false);
  await setImmediate();
  assert.equal(store.getSnapshot().operationId, operationId);
  assert.equal(store.getSnapshot().phone, "13800000999");
  assert.equal(store.getSnapshot().note, "原备注");
  assert.equal(store.getSnapshot().recoveryStatus, "ready");
  assert.equal(store.getSnapshot().phase, "editing");
  assert.equal(
    Reflect.has(
      h.inputs.find((x) => x.operation === "save")!,
      "reading",
    ),
    false,
  );
  stop();
});

test("a rebuilt uncertain workspace retries the original body/id only after durable saving", async () => {
  const h = fixture({ draft: fixtureDraft(), pending_body: body, receipt: null });
  const store = createReceiveWorkspace();
  const stop = connectReceiveRecovery(store, h.port, expected, query);
  await setImmediate();
  assert.equal(store.getSnapshot().phase, "uncertain");
  assert.equal(store.getSnapshot().retryable, true);
  await submitReceive(store, noFallback, { ...body, note: "must not replace original" }, true);
  const submit = h.inputs.find((x) => x.operation === "submit");
  assert.ok(submit?.operation === "submit");
  assert.equal(submit.operation_id, operationId);
  assert.deepEqual(submit.body, body);
  assert.equal(store.getSnapshot().phase, "complete");
  assert.equal(store.getSnapshot().result?.balance_cents, 0);
  stop();
});

test("saving failure never submits and exposes a persistent recoverable error", async () => {
  const h = fixture();
  const store = createReceiveWorkspace();
  const stop = connectReceiveRecovery(store, h.port, expected, query);
  await setImmediate();
  h.reject();
  store.setField("phone", "13800000123");
  await submitReceive(store, noFallback, body);
  assert.equal(h.inputs.filter((x) => x.operation === "submit").length, 0);
  assert.equal(store.getSnapshot().recoveryStatus, "error");
  assert.match(store.getSnapshot().recoveryMessage, /磁盘/u);
  stop();
});

test("recovered committed receipt refreshes later payments before exposing a payable balance", async () => {
  const h = fixture({
    draft: fixtureDraft(),
    pending_body: body,
    receipt: { ok: true, data: { execution: "executed", result: original } },
  });
  const store = createReceiveWorkspace();
  const stop = connectReceiveRecovery(store, h.port, expected, query);
  await setImmediate();
  assert.equal(store.getSnapshot().phase, "complete");
  assert.equal(store.getSnapshot().result?.paid_cents, 1000);
  assert.equal(store.getSnapshot().result?.balance_cents, 0);
  assert.equal(store.getSnapshot().ticketPreview, null);
  assert.equal(h.inputs.filter((x) => x.operation === "submit").length, 0);
  stop();
});

test("failed live balance verification keeps successful recovery locked without showing stale debt", async () => {
  const h = fixture({
    draft: fixtureDraft(),
    pending_body: body,
    receipt: { ok: true, data: { execution: "executed", result: original } },
  });
  const store = createReceiveWorkspace();
  const failing: QueryPort = { execute: async () => ({ ok: false, error: { code: "NETWORK" } }) };
  const stop = connectReceiveRecovery(store, h.port, expected, failing);
  await setImmediate();
  assert.equal(store.getSnapshot().phase, "uncertain");
  assert.equal(store.getSnapshot().result, null);
  assert.match(store.getSnapshot().message, /最新金额/u);
  stop();
});

test("late recovery load after disposal cannot populate or save another employee workspace", async () => {
  let finish!: (result: DesktopReceiveRecoveryResult) => void;
  const calls: DesktopReceiveRecoveryInput[] = [];
  const port: ReceiveRecoveryPort = {
    execute: (input) => {
      calls.push(input);
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const old = createReceiveWorkspace();
  const stop = connectReceiveRecovery(old, port, expected, query);
  stop();
  const next = createReceiveWorkspace();
  finish({ ok: true, data: { ...empty(), draft: fixtureDraft() } });
  await setImmediate();
  assert.equal(old.getSnapshot().phone, "");
  assert.equal(next.getSnapshot().phone, "");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.expected_session, expected);
});

test("browser workspace states the explicit hold boundary and contract rejects scale/tenant injection", () => {
  assert.equal(createReceiveWorkspace().getSnapshot().recoveryStatus, "browser");
  assert.match(createReceiveWorkspace().getSnapshot().recoveryMessage, /暂存挂单/u);
  const input = { operation: "save", expected_session: expected, draft: fixtureDraft() };
  assert.equal(
    DesktopReceiveRecoveryInputSchema.safeParse({ ...input, staff_id: operationId }).success,
    false,
  );
  assert.equal(
    DesktopReceiveRecoveryInputSchema.safeParse({
      ...input,
      draft: { ...input.draft, scaleReading: { weight: 10, stable: true } },
    }).success,
    false,
  );
});

test("a receive the offline queue took shows as queued after submitting and after a restart", async () => {
  const live = fixture({ ...empty(), draft: fixtureDraft() }, offlineReceipt);
  const store = createReceiveWorkspace();
  const stop = connectReceiveRecovery(store, live.port, expected, noOrderRead);
  await setImmediate();
  assert.equal(await submitReceive(store, noFallback, body), null);
  assert.equal(store.getSnapshot().phase, "queued");
  assert.equal(store.getSnapshot().result, null);
  assert.equal(store.getSnapshot().message, "");
  stop();

  const restarted = fixture({ draft: fixtureDraft(), pending_body: body, receipt: offlineReceipt });
  const reopened = createReceiveWorkspace();
  const stopReopened = connectReceiveRecovery(reopened, restarted.port, expected, noOrderRead);
  await setImmediate();
  assert.equal(reopened.getSnapshot().phase, "queued");
  // The queue owns it now, so the clerk can start the next order with a new identity.
  reopened.reset();
  assert.equal(reopened.getSnapshot().phase, "editing");
  assert.notEqual(reopened.getSnapshot().operationId, operationId);
  stopReopened();
});
