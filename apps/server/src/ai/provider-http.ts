import { lookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";

import { validateAiEgressUrl } from "./safety-guard.js";
import { ProviderAdapterError } from "./provider-types.js";

const MAX_REQUEST_BYTES = 262_144;
export const MAX_PROVIDER_RESPONSE_BYTES = 1_048_576;

export type ProviderHttpRequest = Readonly<{
  url: string;
  method: "GET" | "POST";
  headers: Readonly<Record<string, string>>;
  body?: string;
  signal: AbortSignal;
  timeoutMs: number;
}>;

export type ProviderHttpResponse = Readonly<{
  status: number;
  contentType: string | null;
  body: AsyncIterable<Uint8Array>;
}>;

export type ProviderHttpPort = Readonly<{
  request(input: ProviderHttpRequest): Promise<ProviderHttpResponse>;
}>;

type Resolver = (hostname: string) => Promise<readonly string[]>;

const systemResolver: Resolver = async (hostname) => {
  const rows = await lookup(hostname, { all: true, verbatim: true });
  return Object.freeze(rows.map((row) => row.address));
};

export function createPinnedLookup(address: string): NonNullable<RequestOptions["lookup"]> {
  const family = address.includes(":") ? 6 : 4;
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

function mapTransportError(error: unknown, signal: AbortSignal): ProviderAdapterError {
  if (error instanceof ProviderAdapterError) return error;
  if (signal.aborted) return new ProviderAdapterError("PROVIDER_ABORTED");
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  return new ProviderAdapterError(
    code === "AI_PROVIDER_TIMEOUT" ? "PROVIDER_TIMEOUT" : "NETWORK_ERROR",
  );
}

/** HTTPS transport validates every address then pins the socket lookup to one public result. */
export function createPinnedProviderHttp(
  allowedHosts: readonly string[],
  resolveHost: Resolver = systemResolver,
): ProviderHttpPort {
  return Object.freeze({
    async request(input): Promise<ProviderHttpResponse> {
      if (Buffer.byteLength(input.body ?? "", "utf8") > MAX_REQUEST_BYTES) {
        throw new ProviderAdapterError("PROVIDER_RESPONSE_TOO_LARGE");
      }
      let target;
      try {
        target = await validateAiEgressUrl(input.url, allowedHosts, resolveHost);
      } catch {
        throw new ProviderAdapterError("NETWORK_POLICY_DENIED");
      }
      const url = new URL(target.url);
      const pinnedAddress = target.addresses[0];
      if (pinnedAddress === undefined) throw new ProviderAdapterError("NETWORK_POLICY_DENIED");
      try {
        return await new Promise<ProviderHttpResponse>((resolve, reject) => {
          let timedOut = false;
          const options: RequestOptions = {
            method: input.method,
            headers: { ...input.headers },
            signal: input.signal,
            servername: target.hostname,
            lookup: createPinnedLookup(pinnedAddress),
          };
          const request = httpsRequest(url, options, (response) => {
            const safeBody = async function* (): AsyncIterable<Uint8Array> {
              try {
                yield* response;
              } catch (error) {
                if (timedOut) throw new ProviderAdapterError("PROVIDER_TIMEOUT");
                throw mapTransportError(error, input.signal);
              }
            };
            resolve(
              Object.freeze({
                status: response.statusCode ?? 0,
                contentType:
                  typeof response.headers["content-type"] === "string"
                    ? response.headers["content-type"]
                    : null,
                body: safeBody(),
              }),
            );
          });
          request.once("error", reject);
          request.setTimeout(input.timeoutMs, () => {
            timedOut = true;
            const error = new Error("provider request timed out");
            Object.assign(error, { code: "AI_PROVIDER_TIMEOUT" });
            request.destroy(error);
          });
          if (input.body !== undefined) request.write(input.body, "utf8");
          request.end();
        });
      } catch (error) {
        throw mapTransportError(error, input.signal);
      }
    },
  });
}

export function requireSuccessfulResponse(status: number): void {
  if (status >= 200 && status < 300) return;
  if (status === 401 || status === 403) throw new ProviderAdapterError("PROVIDER_AUTH_REJECTED");
  if (status === 429) throw new ProviderAdapterError("PROVIDER_RATE_LIMITED");
  if (status >= 500) throw new ProviderAdapterError("PROVIDER_UNAVAILABLE");
  throw new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
}

async function readBoundedBody(
  body: AsyncIterable<Uint8Array>,
  maximumBytes = MAX_PROVIDER_RESPONSE_BYTES,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > maximumBytes) throw new ProviderAdapterError("PROVIDER_RESPONSE_TOO_LARGE");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

export async function readProviderJson(
  response: ProviderHttpResponse,
  maximumBytes = MAX_PROVIDER_RESPONSE_BYTES,
): Promise<unknown> {
  requireSuccessfulResponse(response.status);
  const bytes = await readBoundedBody(response.body, maximumBytes);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
  } finally {
    bytes.fill(0);
  }
}

export async function* readProviderSse(response: ProviderHttpResponse): AsyncIterable<unknown> {
  requireSuccessfulResponse(response.status);
  let buffered = "";
  let totalBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for await (const chunk of response.body) {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_PROVIDER_RESPONSE_BYTES) {
        throw new ProviderAdapterError("PROVIDER_RESPONSE_TOO_LARGE");
      }
      buffered += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
      let boundary = buffered.indexOf("\n\n");
      while (boundary >= 0) {
        const event = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const payload = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (payload !== "" && payload !== "[DONE]") {
          try {
            yield JSON.parse(payload);
          } catch {
            throw new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
          }
        }
        boundary = buffered.indexOf("\n\n");
      }
    }
    buffered += decoder.decode();
    if (buffered.trim() !== "") throw new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
  } catch (error) {
    if (error instanceof ProviderAdapterError) throw error;
    throw new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
  }
}
