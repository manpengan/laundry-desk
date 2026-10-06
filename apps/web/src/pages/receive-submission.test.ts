import assert from "node:assert/strict";
import test from "node:test";
import type { CommandPort, CommandResult } from "../commands/types.js";
import { blocksUnload, createReceiveWorkspace, hasReceiveWork } from "./receive-workspace.js";
import { submitReceive } from "./receive-submission.js";
import { createHttpCommandClient } from "../commands/command-client.js";
import type { ReceiveOrderResult } from "./receive-result-model.js";

const receipt: ReceiveOrderResult = Object.freeze({
  order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  ticket_no: "20261005-0042",
  pickup_code: "P202610050042",
  payable_cents: 4000,
  paid_cents: 1000,
  balance_cents: 3000,
  discount_cents: 0,
  discount_source: "none",
  discount_bps: 0,
  waivers: { skip_ticket_print: true, skip_label_print: true, skip_rack_assignment: true },
  garment_count: 1,
  garments: [
    {
      garment_id: "11111111-2222-4333-8444-555555555555",
      barcode: "BC-42",
      status: "received",
      line_index: 0,
      seq: 1,
    },
  ],
});
const body = Object.freeze({ customer_phone: "13800000111", initial_payment_cents: 1000 });
function port(handler: (body: unknown) => Promise<CommandResult>): CommandPort {
  return {
    execute: async <T>(_name: string, input: unknown): Promise<CommandResult<T>> => {
      const result = await handler(input);
      return result.ok ? { ok: true, data: result.data as T } : result;
    },
  };
}

test("receive prevents concurrent and post-success resubmission until a new order is started", async () => {
  const store = createReceiveWorkspace();
  let release: (() => void) | undefined;
  let count = 0;
  const client = port(async () => {
    count++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { ok: true, data: receipt };
  });
  const first = submitReceive(store, client, body);
  assert.equal(store.getSnapshot().phase, "submitting");
  assert.equal(await submitReceive(store, client, body), null);
  release?.();
  assert.equal((await first)?.ticket_no, receipt.ticket_no);
  assert.equal(store.getSnapshot().phase, "complete");
  assert.equal(await submitReceive(store, client, body), null);
  assert.equal(count, 1);
  store.reset();
  const next = submitReceive(store, client, body);
  release?.();
  await next;
  assert.equal(count, 2);
});

test("unknown outcome locks editing and explicit retry reuses the exact original payment", async () => {
  const store = createReceiveWorkspace();
  const requests: unknown[] = [];
  const client = port(async (input) => {
    requests.push(input);
    return requests.length === 1
      ? { ok: false, error: { code: "NETWORK" } }
      : { ok: true, data: receipt };
  });
  await submitReceive(store, client, body);
  assert.equal(store.getSnapshot().phase, "uncertain");
  assert.equal(hasReceiveWork(store.getSnapshot()), true);
  assert.equal(await submitReceive(store, client, { initial_payment_cents: 9900 }), null);
  await submitReceive(store, client, { initial_payment_cents: 9900 }, true);
  assert.deepEqual(requests, [body, body]);
  assert.equal(store.getSnapshot().phase, "complete");
});

test("unreadable accepted result never blindly retries; definite validation errors remain editable", async () => {
  const store = createReceiveWorkspace();
  await submitReceive(
    store,
    port(async () => ({ ok: true, data: {} })),
    body,
  );
  assert.equal(store.getSnapshot().phase, "uncertain");
  assert.equal(store.getSnapshot().retryable, false);
  assert.equal(
    await submitReceive(
      store,
      port(async () => {
        throw new Error("must not send");
      }),
      body,
      true,
    ),
    null,
  );
  const other = createReceiveWorkspace();
  await submitReceive(
    other,
    port(async () => ({ ok: false, error: { code: "VALIDATION_FAILED" } })),
    body,
  );
  assert.equal(other.getSnapshot().phase, "editing");
});

test("workspace retains an immutable snapshot across subscribers and isolates the next clerk", () => {
  const first = createReceiveWorkspace();
  const before = first.getSnapshot();
  const unsubscribe = first.subscribe(() => {});
  first.setField("phone", "13800000111");
  unsubscribe();
  assert.equal(before.phone, "");
  assert.equal(first.getSnapshot().phone, "13800000111");
  assert.equal(createReceiveWorkspace().getSnapshot().phone, "");
});

for (const resolution of ["retry", "manual"] as const) {
  test(`HTTP ledger replay distinguishes ${resolution} resolution from an identical new cash order`, async () => {
    const committed = new Map<string, typeof receipt>();
    let lost = false;
    const client = createHttpCommandClient({
      apiBaseUrl: "http://127.0.0.1:8787",
      getAccessToken: () => "test-token",
      readCsrf: () => "test-csrf",
      fetchImpl: async (_input, init) => {
        const key = new Headers(init?.headers).get("idempotency-key")!;
        if (!committed.has(key))
          committed.set(key, { ...receipt, ticket_no: `TEST-${committed.size + 1}` });
        if (!lost) {
          lost = true;
          throw new Error("committed but response lost");
        }
        return new Response(JSON.stringify({ ok: true, data: committed.get(key) }), {
          status: 200,
        });
      },
    });
    const store = createReceiveWorkspace();
    const originalId = store.getSnapshot().operationId;
    await submitReceive(store, client, body);
    assert.equal(store.getSnapshot().phase, "uncertain");
    if (resolution === "retry") {
      await submitReceive(store, client, body, true);
      assert.equal(store.getSnapshot().result?.ticket_no, "TEST-1");
      assert.equal(committed.size, 1);
      assert.equal(store.getSnapshot().operationId, originalId);
    }
    store.reset();
    assert.notEqual(store.getSnapshot().operationId, originalId);
    await submitReceive(store, client, body);
    assert.equal(store.getSnapshot().result?.ticket_no, "TEST-2");
    assert.equal(committed.size, 2);
  });
}

test("leaving the page blocks unsaved browser work but only unjournaled desktop edits", () => {
  const state = createReceiveWorkspace().getSnapshot();
  const blocks = (patch: Partial<typeof state>) => blocksUnload({ ...state, ...patch });
  // A browser session keeps nothing across a reload.
  assert.equal(blocks({ dirty: true }), true);
  assert.equal(blocks({ phase: "uncertain" }), true);
  assert.equal(blocks({ busy: true }), true);
  assert.equal(blocks({}), false);
  // The desktop journal restores saved edits and a pending operation after a reload or restart.
  for (const phase of ["uncertain", "complete", "submitting"] as const)
    assert.equal(blocks({ recoveryStatus: "ready", phase, dirty: true, busy: true }), false);
  for (const recoveryStatus of ["loading", "saving", "error"] as const) {
    assert.equal(blocks({ recoveryStatus, dirty: true }), true);
    assert.equal(blocks({ recoveryStatus, phase: "uncertain" }), false);
  }
});
