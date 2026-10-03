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

for (const mode of ["throw", "abort", "missing_end"] as const)
  test(`unknown usage after ${mode} consumes the whole reservation and blocks another inference`, async () => {
    const store = new MemoryAiConversationStore();
    const controller = new AbortController();
    let calls = 0;
    const service = createAiStreamingService({
      store,
      tool: deterministicSyntheticTool,
      provider: {
        kind: "deterministic_fake",
        async *stream() {
          calls++;
          yield { type: "delta", text: "partial streamed result with no usage report" };
          if (mode === "missing_end") return;
          if (mode === "abort") controller.abort();
          throw new Error("fixture interruption");
        },
      },
    });
    const run = async (signal: AbortSignal) => {
      const session = await service.createSession(context);
      await service.createTurn(
        session.session_id,
        { idempotency_key: randomUUID(), prompt: "fixture", max_output_tokens: 64 },
        context,
      );
      await service.runQueuedTurn(session.session_id, context, signal, async () => undefined);
      return session;
    };
    const session = await run(controller.signal);
    const usage = store.usageSnapshot()[0];
    assert.equal(usage?.inputTokens, 20_000);
    assert.equal(usage?.outputTokens, 64);
    assert.equal(
      (await service.getSession(session.session_id, context)).status,
      mode === "abort" ? "cancelled" : "failed",
    );
    assert.equal((await service.getSafetyStatus(context)).circuit_state, "open");
    await run(new AbortController().signal);
    assert.equal(calls, 1);
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
