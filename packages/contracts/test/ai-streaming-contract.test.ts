import { describe, expect, it } from "vitest";

import {
  AI_EVENT_REPLAY_MAX,
  AI_PROMPT_MAX_CHARS,
  AI_STREAMING_OPERATION_MATRIX,
  AiEventReplayQuerySchema,
  AiStreamEventSchema,
  AiTurnCreateRequestSchema,
} from "../src/index.js";

const TURN_ID = "11111111-1111-4111-8111-111111111111";

describe("Stage 4.5 Item 14 streaming AI contract", () => {
  it("keeps a dedicated provider-neutral HTTP surface out of bus definitions", () => {
    expect(AI_STREAMING_OPERATION_MATRIX).toHaveLength(4);
    expect(new Set(AI_STREAMING_OPERATION_MATRIX.map((row) => row.path)).size).toBe(4);
    expect(AI_STREAMING_OPERATION_MATRIX.every((row) => row.path.startsWith("/api/v2/ai/"))).toBe(
      true,
    );
    expect(AI_STREAMING_OPERATION_MATRIX.every((row) => row.provider_network === false)).toBe(true);
    expect(AI_STREAMING_OPERATION_MATRIX.map((row) => row.operation)).toEqual([
      "session_create",
      "turn_create",
      "events_replay",
      "events_stream",
    ]);
  });

  it("strictly bounds prompt, output tokens, and replay cursor", () => {
    expect(
      AiTurnCreateRequestSchema.parse({
        idempotency_key: TURN_ID,
        prompt: "经营情况如何？",
      }),
    ).toMatchObject({ max_output_tokens: 512 });
    expect(() =>
      AiTurnCreateRequestSchema.parse({
        idempotency_key: TURN_ID,
        prompt: "x".repeat(AI_PROMPT_MAX_CHARS + 1),
      }),
    ).toThrow();
    expect(() =>
      AiTurnCreateRequestSchema.parse({
        idempotency_key: TURN_ID,
        prompt: "ok",
        max_output_tokens: 1025,
      }),
    ).toThrow();
    expect(AiEventReplayQuerySchema.parse({ limit: String(AI_EVENT_REPLAY_MAX) }).limit).toBe(256);
    expect(() => AiEventReplayQuerySchema.parse({ limit: "257" })).toThrow();
  });

  it("accepts only typed deltas, the exact synthetic tool, terminal events, and safe errors", () => {
    expect(
      AiStreamEventSchema.parse({
        type: "content_delta",
        cursor: 1,
        turn_id: TURN_ID,
        at: "2026-08-13T00:00:00.000Z",
        text: "hello",
      }).type,
    ).toBe("content_delta");
    expect(() =>
      AiStreamEventSchema.parse({
        type: "tool_call",
        cursor: 2,
        turn_id: TURN_ID,
        at: "2026-08-13T00:00:00.000Z",
        tool: "order.refund",
        step: 1,
      }),
    ).toThrow();
    expect(() =>
      AiStreamEventSchema.parse({
        type: "error",
        cursor: 3,
        turn_id: TURN_ID,
        at: "2026-08-13T00:00:00.000Z",
        code: "provider-secret-detail",
      }),
    ).toThrow();
  });
});
