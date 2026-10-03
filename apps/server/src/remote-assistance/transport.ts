import { z } from "zod";
import {
  createPinnedProviderHttp,
  readProviderJson,
  type ProviderHttpPort,
} from "../ai/provider-http.js";
import type { AssistanceTrust } from "./protocol.js";

export type AssistanceTransport = Readonly<{
  poll: (sessionId: string, nonce: string, signal: AbortSignal) => Promise<string | null>;
  deliver: (
    sessionId: string,
    requestId: string,
    result: unknown,
    signal: AbortSignal,
  ) => Promise<void>;
}>;
export function assistanceBrokerOrigin(raw: string): string {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(url.hostname) ||
    !url.hostname.includes(".")
  )
    throw new Error("ASSISTANCE_TRUST_INVALID");
  return url.origin;
}
export function createAssistanceTransport(
  trust: AssistanceTrust,
  http: ProviderHttpPort = createPinnedProviderHttp([new URL(trust.broker_url).hostname]),
): AssistanceTransport {
  const origin = assistanceBrokerOrigin(trust.broker_url);
  const send = async (path: "poll" | "result", body: unknown, callerSignal: AbortSignal) => {
    const controller = new AbortController();
    const signal = AbortSignal.any([callerSignal, controller.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("ASSISTANCE_TIMEOUT"));
      }, 10_000);
      timer.unref();
    });
    try {
      return await Promise.race([
        deadline,
        (async () => {
          const response = await http.request({
            url: `${origin}/v1/assistance/${path}`,
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${trust.broker_token}`,
            },
            body: JSON.stringify(body),
            signal,
            timeoutMs: 10_000,
          });
          return readProviderJson(response, 16_384);
        })(),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  };
  return Object.freeze({
    async poll(sessionId, nonce, signal) {
      const result = z
        .strictObject({ command: z.string().max(8192).nullable() })
        .parse(await send("poll", { version: 1, session_id: sessionId, nonce }, signal));
      return result.command;
    },
    async deliver(sessionId, requestId, result, signal) {
      z.strictObject({ accepted: z.literal(true) }).parse(
        await send(
          "result",
          { version: 1, session_id: sessionId, request_id: requestId, result },
          signal,
        ),
      );
    },
  });
}
