import type { CommandResult } from "./types.js";

const ABORTED = Object.freeze({
  ok: false as const,
  error: Object.freeze({ code: "REQUEST_ABORTED", message: "请求已取消" }),
});
const NETWORK_FAILED = Object.freeze({
  ok: false as const,
  error: Object.freeze({ code: "NETWORK", message: "无法连接本地服务器" }),
});

/** Keep operator cancellation distinct from retryable or unknown network outcomes. */
export function requestFailureResult(signal: AbortSignal | undefined): CommandResult<never> {
  return signal?.aborted === true ? ABORTED : NETWORK_FAILED;
}
