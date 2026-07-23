import { z } from "zod";

export const AiProviderNameSchema = z.enum(["openai"]);
export type AiProviderName = z.output<typeof AiProviderNameSchema>;

export const AiToolCallSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(128),
    arguments_json: z.string().max(16_384),
  })
  .strict();
export type AiToolCall = Readonly<{ id: string; name: string; arguments_json: string }>;

export const AiProviderEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text_delta"), text: z.string().min(1).max(16_384) }).strict(),
  z
    .object({ type: z.literal("tool_calls"), calls: z.array(AiToolCallSchema).min(1).max(8) })
    .strict(),
  z.object({ type: z.literal("done") }).strict(),
]);
export type AiProviderEvent =
  | Readonly<{ type: "text_delta"; text: string }>
  | Readonly<{ type: "tool_calls"; calls: readonly AiToolCall[] }>
  | Readonly<{ type: "done" }>;

export const AiToolSchema = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().min(1).max(2_000),
    input_json_schema: z.record(z.string(), z.unknown()),
  })
  .strict();
export type AiTool = Readonly<{
  name: string;
  description: string;
  input_json_schema: Readonly<Record<string, unknown>>;
}>;

export const AiProviderMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.string().min(1).max(12_000) }).strict(),
  z.object({ role: z.literal("user"), content: z.string().min(1).max(12_000) }).strict(),
  z
    .object({
      role: z.literal("assistant"),
      content: z.string().max(12_000),
      tool_calls: z.array(AiToolCallSchema).max(8).optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal("tool"),
      tool_call_id: z.string().min(1).max(128),
      content: z.string().max(16_384),
    })
    .strict(),
]);
export type AiProviderMessage =
  | Readonly<{ role: "system"; content: string }>
  | Readonly<{ role: "user"; content: string }>
  | Readonly<{ role: "assistant"; content: string; tool_calls?: readonly AiToolCall[] | undefined }>
  | Readonly<{ role: "tool"; tool_call_id: string; content: string }>;

export const AiProviderChatInputSchema = z
  .object({
    provider: AiProviderNameSchema,
    api_key: z.string().min(1).max(8_192),
    model: z.string().min(1).max(128),
    messages: z.array(AiProviderMessageSchema).min(2).max(32),
    tools: z.array(AiToolSchema).max(16),
    timeout_ms: z.number().int().min(1_000).max(60_000),
  })
  .strict();
export type AiProviderChatInput = Readonly<{
  provider: AiProviderName;
  api_key: string;
  model: string;
  messages: readonly AiProviderMessage[];
  tools: readonly AiTool[];
  timeout_ms: number;
}>;

export type AiProviderVerification = Readonly<{ ok: true }> | Readonly<{ ok: false }>;

export type AiProvider = Readonly<{
  chat: (input: AiProviderChatInput) => AsyncIterable<AiProviderEvent>;
  verifyKey: (
    input: Readonly<{ provider: AiProviderName; api_key: string }>,
  ) => Promise<AiProviderVerification>;
}>;
