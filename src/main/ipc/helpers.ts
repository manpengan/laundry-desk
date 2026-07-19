import { ZodError, type ZodType } from "zod";
import { type ApiErrorCode, type ApiResponse } from "../../shared";

interface Entry {
  schema: ZodType<unknown>;
  handler: (input: unknown) => unknown;
}
export const channelRegistry = new Map<string, Entry>();

export function registerIpcHandler<Input, Output>(
  channel: string,
  schema: ZodType<Input>,
  handler: (input: Input) => Output | Promise<Output>,
): void {
  channelRegistry.set(channel, {
    schema: schema as ZodType<unknown>,
    handler: handler as (input: unknown) => unknown,
  });
}

export async function invokeChannel(
  channel: string,
  rawInput: unknown,
): Promise<ApiResponse<unknown>> {
  const entry = channelRegistry.get(channel);
  if (!entry) {
    return { ok: false, error: { code: "INTERNAL_ERROR", message: `未知操作: ${channel}` } };
  }
  try {
    const input = entry.schema.parse(rawInput);
    const data = await entry.handler(input);
    return { ok: true, data };
  } catch (error) {
    return toApiError(channel, error);
  }
}

function toApiError(channel: string, error: unknown): ApiResponse<never> {
  if (error instanceof ZodError) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: error.issues[0]?.message ?? "输入参数不正确" } };
  }
  console.error(`Channel Error [${channel}]:`, error);
  return {
    ok: false,
    error: {
      code: toErrorCode(error),
      message: error instanceof Error ? error.message : "系统内部错误",
    },
  };
}

function toErrorCode(error: unknown): ApiErrorCode {
  if (!(error instanceof Error)) return "INTERNAL_ERROR";
  if (error.message.includes("不存在")) return "NOT_FOUND";
  if (error.message.includes("已取件") || error.message.includes("已取消")) return "CONFLICT";
  if (error.message.includes("金额") || error.message.includes("欠款")) return "VALIDATION_FAILED";
  return "INTERNAL_ERROR";
}
