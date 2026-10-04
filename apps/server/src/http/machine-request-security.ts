import { MINIAPP_TRANSACTION_SCHEMAS } from "@laundry/contracts";
import type { RequestSecurityInput, RequestSecurityDecision } from "./request-security.js";
const miniappPost = new Set([
  "/api/v2/miniapp/auth/login",
  "/api/v2/miniapp/auth/logout",
  "/api/v2/miniapp/query",
  "/api/v2/miniapp/subscriptions",
  ...Object.keys(MINIAPP_TRANSACTION_SCHEMAS).map(
    (action) => `/api/v2/miniapp/transactions/${action}`,
  ),
]);
/** Exact native/provider surfaces have their own bearer/signature authority, never cookies. */
export function evaluateMachineRequest(
  input: RequestSecurityInput,
): RequestSecurityDecision | null {
  const path = input.url;
  const publicMiniapp = path === "/api/v2/miniapp/public";
  const miniapp = publicMiniapp || miniappPost.has(path ?? "");
  const callback =
    path === "/api/v2/payment-channels/callback/wechat"
      ? "wechat"
      : path === "/api/v2/payment-channels/callback/alipay"
        ? "alipay"
        : null;
  if (!miniapp && callback === null) return null;
  const values = (name: string) =>
    Object.entries(input.headers).flatMap(([key, value]) =>
      key.toLowerCase() === name && value !== undefined
        ? typeof value === "string"
          ? [value]
          : [...value]
        : [],
    );
  const denied = { allowed: false, statusCode: 403 } as const;
  if (
    values("origin").length !== 0 ||
    values("cookie").length !== 0 ||
    Object.entries(input.headers).some(
      ([key, value]) => key.toLowerCase().startsWith("sec-fetch-") && value !== undefined,
    )
  )
    return denied;
  if (input.method !== (publicMiniapp ? "GET" : "POST")) return denied;
  const authorization = values("authorization");
  if (callback !== null || publicMiniapp || path === "/api/v2/miniapp/auth/login") {
    if (authorization.length !== 0) return denied;
  } else if (
    authorization.length !== 1 ||
    !/^Bearer m1\.[A-Za-z0-9_-]{43}$/u.test(authorization[0]!)
  )
    return denied;
  if (!publicMiniapp) {
    const types = values("content-type");
    const expected =
      callback === "alipay" ? "application/x-www-form-urlencoded" : "application/json";
    if (types.length !== 1 || types[0]!.split(";")[0]!.trim().toLowerCase() !== expected)
      return { allowed: false, statusCode: 415 };
  }
  return { allowed: true };
}
