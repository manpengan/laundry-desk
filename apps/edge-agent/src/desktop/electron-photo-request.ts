import { DESKTOP_MAX_PHOTO_BYTES } from "@laundry/contracts";

import {
  DESKTOP_API_BASE_URL,
  DESKTOP_REQUEST_ORIGIN,
  type DesktopHttpRequest,
} from "./request-builder.js";
import type { DesktopPhotoHttpResponse } from "./http-transport.js";

const PHOTO_PATH =
  /^\/api\/v2\/photos\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\/thumbnail)?$/iu;
const PHOTO_REQUEST_TIMEOUT_MS = 15_000;
const PHOTO_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type IncomingPhotoResponse = Readonly<{
  statusCode: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  on: {
    (event: "data", listener: (chunk: Buffer | Uint8Array | string) => void): unknown;
    (event: "end", listener: () => void): unknown;
    (event: "error", listener: (error: Error) => void): unknown;
  };
}>;

type PhotoClientRequest = Readonly<{
  once: {
    (event: "response", listener: (response: IncomingPhotoResponse) => void): unknown;
    (event: "error", listener: (error: Error) => void): unknown;
  };
  end: () => void;
  abort: () => void;
}>;

type PhotoNet<TSession> = Readonly<{
  request: (
    options: Readonly<{
      method: "GET";
      url: string;
      headers: Readonly<Record<string, string>>;
      session: TSession;
      credentials: "include";
      redirect: "error";
      origin: typeof DESKTOP_REQUEST_ORIGIN;
    }>,
  ) => PhotoClientRequest;
}>;

function assertPhotoRequest(request: DesktopHttpRequest): void {
  const url = new URL(request.url);
  const keys = Object.keys(request.headers).map((key) => key.toLowerCase());
  if (
    request.method !== "GET" ||
    request.body !== undefined ||
    request.credentials !== "include" ||
    request.redirect !== "error" ||
    request.origin !== DESKTOP_REQUEST_ORIGIN ||
    url.origin !== DESKTOP_API_BASE_URL ||
    url.search !== "" ||
    url.hash !== "" ||
    !PHOTO_PATH.test(url.pathname) ||
    keys.length !== 3 ||
    new Set(keys).size !== 3 ||
    !keys.includes("origin") ||
    !keys.includes("sec-fetch-site") ||
    !keys.includes("authorization") ||
    request.headers.Origin !== DESKTOP_REQUEST_ORIGIN ||
    request.headers["Sec-Fetch-Site"] !== "same-origin" ||
    !/^Bearer [^\r\n]+$/u.test(request.headers.Authorization ?? "")
  ) {
    throw new Error("Request violates the fixed desktop photo policy");
  }
}

function contentType(headers: IncomingPhotoResponse["headers"]): string {
  const raw = headers["content-type"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? (value.split(";", 1)[0]?.trim().toLowerCase() ?? "") : "";
}

function normalizedChunk(chunk: Buffer | Uint8Array | string): Buffer {
  return typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
}

export async function executeElectronPhotoRequest<TSession>(
  net: PhotoNet<TSession>,
  session: TSession,
  request: DesktopHttpRequest,
): Promise<DesktopPhotoHttpResponse> {
  assertPhotoRequest(request);
  return new Promise<DesktopPhotoHttpResponse>((resolve, reject) => {
    let settled = false;
    const clientRequest = net.request({
      method: "GET",
      url: request.url,
      headers: request.headers,
      session,
      credentials: "include",
      redirect: "error",
      origin: DESKTOP_REQUEST_ORIGIN,
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clientRequest.abort();
      reject(new Error("Desktop photo request timed out"));
    }, PHOTO_REQUEST_TIMEOUT_MS);
    timer.unref();
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    clientRequest.once("error", fail);
    clientRequest.once("response", (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("error", fail);
      response.on("data", (chunk) => {
        if (settled) return;
        const normalized = normalizedChunk(chunk);
        bytes += normalized.byteLength;
        if (bytes > DESKTOP_MAX_PHOTO_BYTES) {
          clientRequest.abort();
          fail(new Error("Desktop photo response is too large"));
          return;
        }
        chunks.push(normalized);
      });
      response.on("end", () => {
        if (settled) return;
        const type = contentType(response.headers);
        if (
          !Number.isSafeInteger(response.statusCode) ||
          response.statusCode < 100 ||
          response.statusCode > 599 ||
          (response.statusCode >= 200 &&
            response.statusCode < 300 &&
            !PHOTO_CONTENT_TYPES.has(type))
        ) {
          fail(new Error("Desktop photo response is invalid"));
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(
          Object.freeze({
            statusCode: response.statusCode,
            contentType: type,
            bodyBytes: Uint8Array.from(Buffer.concat(chunks)),
          }),
        );
      });
    });
    clientRequest.end();
  });
}
