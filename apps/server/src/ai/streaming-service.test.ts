import assert from "node:assert/strict";
import test from "node:test";

import type { AiStreamEvent } from "@laundry/contracts";

import { MemoryAiConversationStore } from "./streaming-memory-store.js";
import {
  createDeterministicFakeProvider,
  deterministicSyntheticTool,
  type SyntheticToolPort,
} from "./streaming-provider.js";
import { AiServiceError, createAiStreamingService } from "./streaming-service.js";
import type { AiRequestContext } from "./streaming-store.js";

const CONTEXT: AiRequestContext = Object.freeze({
  tenant: Object.freeze({
    orgId: "11111111-1111-4111-8111-111111111111",
    storeId: "22222222-2222-4222-8222-222222222222",
    staffId: "33333333-3333-4333-8333-333333333333",
  }),
  authSessionId: "44444444-4444-4444-8444-444444444444",
  deviceId: "55555555-5555-4555-8555-555555555555",
});
const OTHER_CONTEXT: AiRequestContext = Object.freeze({
  ...CONTEXT,
  tenant: Object.freeze({ ...CONTEXT.tenant, staffId: "66666666-6666-4666-8666-666666666666" }),
  authSessionId: "77777777-7777-4777-8777-777777777777",
});

const END_STOP = Object.freeze({
  type: "end" as const,
  finishReason: "stop" as const,
  inputTokens: 3,
  outputTokens: 2,
});
const END_TOOLS = Object.freeze({
  type: "end" as const,
  finishReason: "tool_calls" as const,
  inputTokens: 2,
  outputTokens: 1,
});

async function sessionAndTurn(
  store: MemoryAiConversationStore,
  service: ReturnType<typeof createAiStreamingService>,
  idempotencyKey = "88888888-8888-4888-8888-888888888888",
) {
  const session = await service.createSession(CONTEXT);
  const turn = await service.createTurn(
    session.session_id,
    { idempotency_key: idempotencyKey, prompt: "只读查询", max_output_tokens: 32 },
    CONTEXT,
  );
  return { store, service, session, turn };
}

test("runtime is hard-off without an explicitly injected deterministic fake", async () => {
  const service = createAiStreamingService({
    store: new MemoryAiConversationStore(),
    provider: null,
    tool: deterministicSyntheticTool,
  });
  assert.equal(service.enabled, false);
  await assert.rejects(
    () => service.createSession(CONTEXT),
    (error: unknown) => {
      assert.ok(error instanceof AiServiceError);
      assert.equal(error.code, "AI_UNAVAILABLE");
      return true;
    },
  );
});

test("fake provider persists typed deltas, exact read-only tool, usage, and metadata-only audit", async () => {
  const store = new MemoryAiConversationStore();
  const provider = createDeterministicFakeProvider([
    {
      events: [
        { type: "tool_call", callId: "call-1", name: "synthetic.lookup", args: { query: "today" } },
        END_TOOLS,
      ],
    },
    { events: [{ type: "delta", text: "结果正常" }, END_STOP] },
  ]);
  const service = createAiStreamingService({ store, provider, tool: deterministicSyntheticTool });
  const { session, turn } = await sessionAndTurn(store, service);
  const streamed: AiStreamEvent[] = [];
  await service.runQueuedTurn(
    session.session_id,
    CONTEXT,
    new AbortController().signal,
    async (event) => {
      streamed.push(event);
    },
  );

  assert.equal(turn.status, "queued");
  assert.deepEqual(
    streamed.map((event) => event.type),
    ["tool_call", "tool_result", "content_delta", "done"],
  );
  assert.equal(streamed.at(-1)?.cursor, 4);
  assert.deepEqual(
    (await service.listEvents(session.session_id, 2, 2, CONTEXT)).map((event) => event.type),
    ["content_delta", "done"],
  );
  assert.equal((await service.getSession(session.session_id, CONTEXT)).status, "completed");
  assert.equal(store.toolAttemptSnapshot()[0]?.outcome, "succeeded");
  assert.deepEqual(store.usageSnapshot()[0], {
    id: store.usageSnapshot()[0]?.id,
    inputTokens: 5,
    outputTokens: 3,
    outputBytes: Buffer.byteLength("结果正常", "utf8"),
    eventCount: 4,
    toolSteps: 1,
  });
  const audit = JSON.stringify(store.auditSnapshot());
  assert.match(audit, /prompt_sha256/iu);
  assert.doesNotMatch(audit, /只读查询|结果正常|today/iu);
});

test("turn idempotency replays only the same hash and single active turn is enforced", async () => {
  const store = new MemoryAiConversationStore();
  const service = createAiStreamingService({
    store,
    provider: createDeterministicFakeProvider([{ events: [END_STOP] }]),
    tool: deterministicSyntheticTool,
  });
  const { session, turn } = await sessionAndTurn(store, service);
  const replay = await service.createTurn(
    session.session_id,
    {
      idempotency_key: "88888888-8888-4888-8888-888888888888",
      prompt: "只读查询",
      max_output_tokens: 32,
    },
    CONTEXT,
  );
  assert.equal(replay.turn_id, turn.turn_id);
  assert.equal(replay.replayed, true);
  await assert.rejects(
    () =>
      service.createTurn(
        session.session_id,
        {
          idempotency_key: "88888888-8888-4888-8888-888888888888",
          prompt: "变更输入",
          max_output_tokens: 32,
        },
        CONTEXT,
      ),
    (error: unknown) => error instanceof AiServiceError && error.code === "IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    () =>
      service.createTurn(
        session.session_id,
        {
          idempotency_key: "99999999-9999-4999-8999-999999999999",
          prompt: "第二轮",
          max_output_tokens: 32,
        },
        CONTEXT,
      ),
    (error: unknown) => error instanceof AiServiceError && error.code === "ACTIVE_TURN",
  );
});

test("disconnect aborts provider and leaves a durable cancelled terminal event", async () => {
  const store = new MemoryAiConversationStore();
  const service = createAiStreamingService({
    store,
    provider: createDeterministicFakeProvider([
      { events: [{ type: "delta", text: "不应完成" }, END_STOP], delayMs: 500 },
    ]),
    tool: deterministicSyntheticTool,
  });
  const { session } = await sessionAndTurn(store, service);
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 10);
  await service.runQueuedTurn(session.session_id, CONTEXT, abort.signal, async () => undefined);
  const events = await service.listEvents(session.session_id, 0, 256, CONTEXT);
  const last = events.at(-1);
  assert.equal(last?.type, "error");
  assert.equal(last?.type === "error" ? last.code : null, "AI_ABORTED");
  assert.equal((await service.getSession(session.session_id, CONTEXT)).status, "cancelled");
});

test("tool loop stops before a fifth attempt", async () => {
  const store = new MemoryAiConversationStore();
  const toolStep = (index: number) => ({
    events: [
      {
        type: "tool_call" as const,
        callId: `call-${index}`,
        name: "synthetic.lookup",
        args: { query: `q${index}` },
      },
      END_TOOLS,
    ],
  });
  const service = createAiStreamingService({
    store,
    provider: createDeterministicFakeProvider([1, 2, 3, 4, 5].map(toolStep)),
    tool: deterministicSyntheticTool,
  });
  const { session } = await sessionAndTurn(store, service);
  await service.runQueuedTurn(
    session.session_id,
    CONTEXT,
    new AbortController().signal,
    async () => undefined,
  );
  const events = await service.listEvents(session.session_id, 0, 256, CONTEXT);
  const last = events.at(-1);
  assert.equal(store.toolAttemptSnapshot().length, 4);
  assert.equal(last?.type === "error" ? last.code : null, "AI_TOOL_LIMIT");
});

test("tool timeout cancels work and records no raw args", async () => {
  const store = new MemoryAiConversationStore();
  const slowTool: SyntheticToolPort = Object.freeze({
    async lookup(_input, signal) {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return Object.freeze({ unreachable: true });
    },
  });
  const service = createAiStreamingService({
    store,
    provider: createDeterministicFakeProvider([
      {
        events: [
          {
            type: "tool_call",
            callId: "slow",
            name: "synthetic.lookup",
            args: { query: "private" },
          },
          END_TOOLS,
        ],
      },
    ]),
    tool: slowTool,
  });
  const { session } = await sessionAndTurn(store, service);
  await service.runQueuedTurn(
    session.session_id,
    CONTEXT,
    new AbortController().signal,
    async () => undefined,
  );
  const events = await service.listEvents(session.session_id, 0, 256, CONTEXT);
  const last = events.at(-1);
  assert.equal(store.toolAttemptSnapshot()[0]?.outcome, "timed_out");
  assert.equal(last?.type === "error" ? last.code : null, "AI_TOOL_TIMEOUT");
  assert.doesNotMatch(JSON.stringify(store.toolAttemptSnapshot()), /private/iu);
});

test("output byte, event, and token budgets persist bounded terminal state", async () => {
  const cases = [
    [{ type: "delta" as const, text: "x".repeat(32_769) }],
    Array.from({ length: 256 }, () => ({ type: "delta" as const, text: "x" })),
    [{ ...END_STOP, outputTokens: 33 }],
  ];
  for (const events of cases) {
    const store = new MemoryAiConversationStore();
    const service = createAiStreamingService({
      store,
      provider: createDeterministicFakeProvider([{ events }]),
      tool: deterministicSyntheticTool,
    });
    const { session } = await sessionAndTurn(store, service);
    await service.runQueuedTurn(
      session.session_id,
      CONTEXT,
      new AbortController().signal,
      async () => undefined,
    );
    const persisted = await service.listEvents(session.session_id, 0, 256, CONTEXT);
    const terminal = persisted.at(-1);
    assert.equal(terminal?.type === "error" ? terminal.code : null, "AI_OUTPUT_LIMIT");
    const usage = store.usageSnapshot()[0];
    assert.ok(usage !== undefined);
    assert.ok(usage.outputBytes <= 32_768);
    assert.ok(usage.eventCount <= 256);
    assert.ok(usage.outputTokens <= 32);
  }
});

test("staff and auth-session scope prevents cross-context replay", async () => {
  const store = new MemoryAiConversationStore();
  const service = createAiStreamingService({
    store,
    provider: createDeterministicFakeProvider([{ events: [END_STOP] }]),
    tool: deterministicSyntheticTool,
  });
  const { session } = await sessionAndTurn(store, service);
  await assert.rejects(
    () => service.listEvents(session.session_id, 0, 10, OTHER_CONTEXT),
    (error: unknown) => error instanceof AiServiceError && error.code === "NOT_FOUND",
  );
});
