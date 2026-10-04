import { failedBeforeSending } from "../http/unsent-failure.js";
import { ChannelProtocolError, type ChannelHttp, type PaymentChannel } from "./types.js";

const origins: Readonly<Record<PaymentChannel, string>> = Object.freeze({
  wechat: "https://api.mch.weixin.qq.com",
  alipay: "https://openapi.alipay.com",
});
const MAX_BODY_BYTES = 1_048_576;

/** A rejected fetch is "not sent" only when its cause proves the connection never opened. */
export function sendFailure(error: unknown): ChannelProtocolError {
  return new ChannelProtocolError(
    failedBeforeSending(error) ? "CHANNEL_NOT_SENT" : "CHANNEL_TRANSPORT_FAILED",
  );
}

async function readBounded(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_BODY_BYTES) throw new ChannelProtocolError("CHANNEL_TRANSPORT_FAILED");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

export function createChannelHttp(fetchPort: typeof fetch = fetch): ChannelHttp {
  return async (request) => {
    if (!/^\/v3\/[A-Za-z0-9/_?.=%&-]+$/u.test(request.path))
      throw new ChannelProtocolError("CHANNEL_NOT_SENT");
    const url = new URL(request.path, origins[request.channel]);
    if (url.origin !== origins[request.channel]) throw new ChannelProtocolError("CHANNEL_NOT_SENT");
    let response: Response;
    try {
      response = await fetchPort(url, {
        method: request.method,
        headers: { ...request.headers, Accept: "application/json" },
        ...(request.method === "POST" ? { body: request.body } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      throw sendFailure(error);
    }
    // From here the provider has the request: every failure is "result unknown".
    try {
      if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES)
        throw new ChannelProtocolError("CHANNEL_TRANSPORT_FAILED");
      if (response.body === null && response.status !== 204)
        throw new ChannelProtocolError("CHANNEL_TRANSPORT_FAILED");
      return Object.freeze({
        status: response.status,
        headers: Object.freeze(Object.fromEntries(response.headers.entries())),
        body: await readBounded(response),
      });
    } catch {
      throw new ChannelProtocolError("CHANNEL_TRANSPORT_FAILED");
    }
  };
}
export const channelHttp = createChannelHttp();
