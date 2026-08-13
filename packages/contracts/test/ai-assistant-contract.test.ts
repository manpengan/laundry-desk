import { describe, expect, it } from "vitest";

import {
  AI_ASSISTANT_MAX_RESULTS,
  AI_ASSISTANT_MAX_TOOL_CALLS,
  AI_ASSISTANT_TOOL_NAMES,
  AiAssistantToolCallSchema,
  AiAssistantToolResultSchema,
  AiStreamEventSchema,
} from "../src/index.js";

describe("Item 15 read-only assistant contract", () => {
  it("freezes exactly three named tools and strict bounded arguments", () => {
    expect(AI_ASSISTANT_TOOL_NAMES).toEqual([
      "business.summary",
      "records.search",
      "procedure.troubleshoot",
    ]);
    expect(AI_ASSISTANT_MAX_TOOL_CALLS).toBe(3);
    expect(AI_ASSISTANT_MAX_RESULTS).toBe(10);
    expect(
      AiAssistantToolCallSchema.parse({
        tool: "records.search",
        args: { scope: "orders", query: "A001", limit: 10 },
      }),
    ).toMatchObject({ tool: "records.search" });
    expect(() =>
      AiAssistantToolCallSchema.parse({
        tool: "records.search",
        args: { scope: "orders", query: "A001", sql: "select *" },
      }),
    ).toThrow();
    expect(() =>
      AiAssistantToolCallSchema.parse({ tool: "http.get", args: { url: "https://example.com" } }),
    ).toThrow();
  });

  it("requires sources, explicit filters and bounded safe scalar results", () => {
    const parsed = AiAssistantToolResultSchema.parse({
      summary: "找到 1 个订单候选；顾客资料已脱敏。",
      result_count: 1,
      sources: [{ kind: "query", ref: "query:order.lookup:0.1.0", label: "订单检索" }],
      filters: [{ field: "lookup_key", value: "redacted" }],
      items: [{ ticket_no: "A001", phone_masked: "*******0001", balance_cents: 0 }],
    });
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.filters).toEqual([{ field: "lookup_key", value: "redacted" }]);
    expect(() =>
      AiAssistantToolResultSchema.parse({ ...parsed, sources: [], items: Array(11).fill({}) }),
    ).toThrow();
  });

  it("projects all tool names into typed SSE events without payloads", () => {
    for (const tool of AI_ASSISTANT_TOOL_NAMES) {
      const event = AiStreamEventSchema.parse({
        cursor: 1,
        turn_id: "11111111-1111-4111-8111-111111111111",
        at: "2026-08-13T00:00:00.000Z",
        type: "tool_result",
        tool,
        step: 1,
        outcome: "succeeded",
      });
      if (event.type !== "tool_result") throw new Error("EXPECTED_TOOL_RESULT_EVENT");
      expect(event.tool).toBe(tool);
      expect(event).not.toHaveProperty("args");
      expect(event).not.toHaveProperty("result");
    }
  });
});
