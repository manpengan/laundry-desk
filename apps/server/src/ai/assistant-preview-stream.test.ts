import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { MemoryAiConversationStore } from "./streaming-memory-store.js";
import { createAiStreamingService } from "./streaming-service.js";
import {
  deterministicSyntheticTool,
  type AiProviderRequest,
  type AiProviderPort,
} from "./streaming-provider.js";

test("preview cards reach authenticated replay, never provider context; cumulative output limit shrinks", async () => {
  const store = new MemoryAiConversationStore();
  const context = {
    tenant: { orgId: randomUUID(), storeId: randomUUID(), staffId: randomUUID() },
    authSessionId: randomUUID(),
    deviceId: randomUUID(),
  };
  const card = {
    command: "garment.rework" as const,
    confirm_ref: randomUUID(),
    summary: "人工核对条码 BAR-1 后返洗",
    expires_at: new Date(Date.now() + 300000).toISOString(),
  };
  const requests: AiProviderRequest[] = [];
  const provider: AiProviderPort = {
    kind: "deterministic_fake",
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        yield {
          type: "tool_call",
          callId: "one",
          name: "operations.preview",
          args: {
            command: "garment.rework",
            input: { garment_ids: [randomUUID()], reason: "污渍" },
          },
        };
        yield { type: "end", finishReason: "tool_calls", inputTokens: 10, outputTokens: 12 };
      } else {
        yield { type: "delta", text: "请在独立确认卡核对。" };
        yield { type: "end", finishReason: "stop", inputTokens: 10, outputTokens: 8 };
      }
    },
  };
  const service = createAiStreamingService({
    store,
    provider,
    tool: deterministicSyntheticTool,
    assistantTool: {
      async execute() {
        return {
          summary: "等待人工确认",
          result_count: 1,
          sources: [{ kind: "document", ref: "document:operations.policy:1", label: "操作政策" }],
          filters: [],
          items: [{ executed: false }],
          preview: card,
        };
      },
    },
  });
  const session = await service.createSession(context);
  await service.createTurn(
    session.session_id,
    { idempotency_key: randomUUID(), prompt: "准备返洗", max_output_tokens: 32 },
    context,
  );
  await service.runQueuedTurn(
    session.session_id,
    context,
    AbortSignal.timeout(3000),
    async () => undefined,
  );
  assert.equal(requests[1]?.maxOutputTokens, 20);
  assert.equal(JSON.stringify(requests).includes(card.confirm_ref), false);
  assert.equal(JSON.stringify(requests).includes(card.summary), false);
  const events = await service.listEvents(session.session_id, 0, 100, context);
  assert.deepEqual(events.find((event) => event.type === "tool_result")?.type, "tool_result");
  const result = events.find((event) => event.type === "tool_result");
  assert.deepEqual(result?.type === "tool_result" ? result.preview : null, card);
  assert.equal(store.toolAttemptSnapshot()[0]?.outcome, "succeeded");
  assert.equal(JSON.stringify(store.auditSnapshot()).includes(card.confirm_ref), false);
});
