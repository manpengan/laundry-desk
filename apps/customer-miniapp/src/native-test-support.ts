import type { WxPort } from "./wx-port.js";

export const APP_ID = "wx1234567890abcdef";
export const TOKEN = `m1.${"s".repeat(43)}`;
export type Request = Parameters<WxPort["request"]>[0];
export function nativeHarness(handle: (request: Request) => void) {
  let requests: readonly Request[] = [];
  let payments: readonly Parameters<WxPort["requestPayment"]>[0][] = [];
  let subscriptions: readonly string[] = [];
  let randomCalls = 0;
  let aborts = 0;
  const wx: WxPort = {
    getAccountInfoSync: () => ({ miniProgram: { appId: APP_ID } }),
    getRandomValues: ({ success }) => {
      randomCalls += 1;
      success({
        randomValues: new Uint8Array(Array.from({ length: 16 }, (_, index) => index + randomCalls))
          .buffer,
      });
    },
    login: ({ success }) => success({ code: "synthetic-login-code" }),
    request: (request) => {
      requests = [...requests, request];
      queueMicrotask(() => handle(request));
      return {
        abort() {
          aborts += 1;
          request.fail({ errMsg: "abort" });
        },
      };
    },
    requestPayment: (request) => {
      payments = [...payments, request];
      request.success();
    },
    requestSubscribeMessage: (request) => {
      subscriptions = request.tmplIds;
      request.success(
        Object.fromEntries(
          request.tmplIds.map((id, index) => [id, index === 0 ? "accept" : "reject"]),
        ),
      );
    },
    showModal: ({ success }) => success({ confirm: true }),
  };
  return {
    wx,
    requests: () => requests,
    payments: () => payments,
    subscriptions: () => subscriptions,
    randomCalls: () => randomCalls,
    aborts: () => aborts,
  };
}
export const reply = (request: Request, data: unknown) =>
  request.success({ statusCode: 200, data: { ok: true, data } });
export const loginReply = (request: Request) =>
  reply(request, {
    authenticated: true,
    access_token: TOKEN,
    expires_at: Math.floor(Date.now() / 1000) + 900,
  });
