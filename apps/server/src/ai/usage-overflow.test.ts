import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { MemoryAiConversationStore } from "./streaming-memory-store.js";
import { createAiStreamingService } from "./streaming-service.js";
import { deterministicSyntheticTool, type AiProviderPort } from "./streaming-provider.js";
const context = {
  tenant: { orgId: randomUUID(), storeId: randomUUID(), staffId: randomUUID() },
  authSessionId: randomUUID(),
  deviceId: randomUUID(),
};
for (const [reported, expected, blocked] of [
  [100, 100, false],
  [5000, 64, true],
] as const)
  test(`provider output ${reported} is debited and ${blocked ? "quarantined" : "fails without losing actual usage"}`, async () => {
    const store = new MemoryAiConversationStore();
    let calls = 0;
    const provider: AiProviderPort = {
      kind: "deterministic_fake",
      async *stream() {
        calls++;
        yield { type: "end", finishReason: "stop", inputTokens: 10, outputTokens: reported };
      },
    };
    const service = createAiStreamingService({ store, provider, tool: deterministicSyntheticTool });
    const run = async () => {
      const session = await service.createSession(context);
      await service.createTurn(
        session.session_id,
        { idempotency_key: randomUUID(), prompt: "fixture", max_output_tokens: 64 },
        context,
      );
      await service.runQueuedTurn(
        session.session_id,
        context,
        new AbortController().signal,
        async () => undefined,
      );
      return session;
    };
    const session = await run();
    assert.equal(store.usageSnapshot()[0]?.outputTokens, expected);
    assert.equal(store.usageSnapshot()[0]?.inputTokens, blocked ? 20_000 : 10);
    assert.ok((store.usageSnapshot()[0]?.estimatedCostMicros ?? 0) > 0);
    assert.equal((await service.getSession(session.session_id, context)).status, "failed");
    assert.equal(
      (await service.getSafetyStatus(context)).circuit_state,
      blocked ? "open" : "closed",
    );
    await run();
    assert.equal(calls, blocked ? 1 : 2);
  });

type Mode = "throw" | "abort" | "missing_end" | "unbilled" | "unbilled_after_output";
function interruptedService(mode: Mode) {
  const store = new MemoryAiConversationStore();
  let controller = new AbortController();
  let calls = 0;
  const service = createAiStreamingService({
    store,
    tool: deterministicSyntheticTool,
    provider: {
      kind: "deterministic_fake",
      async *stream() {
        calls++;
        if (mode === "unbilled") {
          // e.g. HTTP 401 or a refused connection: the provider never ran the request.
          yield { type: "error", code: "provider_auth_rejected", unbilled: true };
          return;
        }
        yield { type: "delta", text: "partial streamed result with no usage report" };
        if (mode === "unbilled_after_output")
          yield { type: "error", code: "provider_unavailable", unbilled: true };
        if (mode === "missing_end" || mode === "unbilled_after_output") return;
        if (mode === "abort") controller.abort();
        throw new Error("fixture interruption");
      },
    },
  });
  const run = async () => {
    controller = new AbortController();
    const session = await service.createSession(context);
    await service.createTurn(
      session.session_id,
      { idempotency_key: randomUUID(), prompt: "fixture", max_output_tokens: 64 },
      context,
    );
    await service.runQueuedTurn(session.session_id, context, controller.signal, async () => {
      return undefined;
    });
    return (await service.getSession(session.session_id, context)).status;
  };
  return { store, service, run, calls: () => calls };
}

for (const mode of ["throw", "missing_end", "unbilled_after_output"] as const)
  test(`unknown usage after ${mode} is debited in full and quarantines only the third time a day`, async () => {
    const f = interruptedService(mode);
    assert.equal(await f.run(), "failed");
    const usage = f.store.usageSnapshot()[0];
    assert.equal(usage?.inputTokens, 20_000);
    assert.equal(usage?.outputTokens, 64);
    const quarantined = async () =>
      (await f.service.getSafetyStatus(context)).circuit_open_until === "9999-12-31T00:00:00.000Z";
    assert.equal(await quarantined(), false, "one lost stream must not disable the organisation");
    await f.run();
    assert.equal(f.calls(), 2);
    assert.equal(await quarantined(), false);
    await f.run();
    assert.equal(await quarantined(), true);
    await f.run();
    assert.equal(f.calls(), 3);
  });

test("a staff stop debits the reservation but never quarantines", async () => {
  const f = interruptedService("abort");
  for (let index = 0; index < 4; index++) assert.equal(await f.run(), "cancelled");
  assert.equal(f.calls(), 4);
  assert.equal(f.store.usageSnapshot()[0]?.inputTokens, 20_000);
  assert.equal((await f.service.getSafetyStatus(context)).circuit_state, "closed");
});

test("a request the provider never ran costs nothing and only feeds the circuit breaker", async () => {
  const f = interruptedService("unbilled");
  assert.equal(await f.run(), "failed");
  assert.equal(f.store.usageSnapshot()[0]?.inputTokens, 0);
  assert.equal(f.store.usageSnapshot()[0]?.estimatedCostMicros, 0);
  await f.run();
  await f.run();
  // Three consecutive failures open the short circuit (minutes), not the quarantine.
  const status = await f.service.getSafetyStatus(context);
  assert.equal(status.circuit_state, "open");
  assert.notEqual(status.circuit_open_until, "9999-12-31T00:00:00.000Z");
  assert.equal(f.calls(), 3);
});

test("budget rejection before entering the provider does not charge or quarantine", async () => {
  const store = new MemoryAiConversationStore({
    monthlyLimitMicros: 0,
    inputMicrosPerMillion: 1_000_000,
    outputMicrosPerMillion: 4_000_000,
    circuitFailureThreshold: 3,
    circuitOpenMs: 300_000,
  });
  let calls = 0;
  const service = createAiStreamingService({
    store,
    tool: deterministicSyntheticTool,
    provider: {
      kind: "deterministic_fake",
      async *stream() {
        calls++;
        yield { type: "end", finishReason: "stop", inputTokens: 1, outputTokens: 1 };
      },
    },
  });
  const session = await service.createSession(context);
  await service.createTurn(
    session.session_id,
    { idempotency_key: randomUUID(), prompt: "fixture", max_output_tokens: 64 },
    context,
  );
  await service.runQueuedTurn(
    session.session_id,
    context,
    new AbortController().signal,
    async () => undefined,
  );
  assert.equal(calls, 0);
  assert.equal(store.usageSnapshot()[0]?.estimatedCostMicros ?? 0, 0);
  assert.equal((await service.getSafetyStatus(context)).circuit_state, "closed");
});
