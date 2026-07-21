/**
 * Fastify request decoration for local HTTP (C8-style).
 */

import type { SessionRecord } from "../identity/types.js";

export type RequestAuthBinding = Readonly<{
  session: SessionRecord | null;
  refreshSecret: string | null;
  accessToken: string | null;
}>;

export type CookieNames = Readonly<{
  refresh: string;
  csrf: string;
}>;

export const LOCAL_COOKIE_NAMES: CookieNames = Object.freeze({
  refresh: "laundry_refresh",
  csrf: "laundry_csrf",
});
