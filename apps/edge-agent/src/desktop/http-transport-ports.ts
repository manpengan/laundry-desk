import type { DesktopLoginInput } from "@laundry/contracts";

import type { DeviceRequestSigner } from "./edge-http.js";
import type { AsyncSchema } from "./http-transport-support.js";
import type { DesktopHttpRequest } from "./request-builder.js";

export type DesktopHttpResponse = Readonly<{ statusCode: number; bodyText: string }>;
export type DesktopPhotoHttpResponse = Readonly<{
  statusCode: number;
  contentType: string;
  bodyBytes: Uint8Array;
}>;
export type DesktopCookie = Readonly<{ name: string; value: string }>;
export type DesktopCookieStore = Readonly<{
  get: (url: string) => Promise<readonly DesktopCookie[]>;
  clear: (url: string) => Promise<void>;
}>;
export type DesktopHttpTransportDependencies = Readonly<{
  request: (request: DesktopHttpRequest) => Promise<DesktopHttpResponse>;
  photoRequest?: (request: DesktopHttpRequest) => Promise<DesktopPhotoHttpResponse>;
  cookies: DesktopCookieStore;
  deviceId: string;
  /** Main-process-only device key; absence disables all Edge authority operations. */
  deviceSigner?: DeviceRequestSigner;
  nowMs?: () => number;
  monotonicNowMs?: () => number;
  loginInputSchema?: AsyncSchema<DesktopLoginInput>;
}>;
