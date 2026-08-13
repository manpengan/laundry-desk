import {
  CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME,
  CustomerPortalBenefitsResultSchema,
  CustomerPortalGarmentProgressResultSchema,
  CustomerPortalGarmentsListResultSchema,
  CustomerPortalLoginInputSchema,
  CustomerPortalOrderGetResultSchema,
  CustomerPortalOrdersListResultSchema,
  CustomerPortalProfileMutationResultSchema,
  CustomerPortalProfileResultSchema,
  CustomerPortalProfileUpdateInputSchema,
  CustomerPortalReceiptResultSchema,
  CustomerPortalSessionSchema,
  CustomerPortalWalletResultSchema,
  customerPortalCookieNames,
  type CustomerPortalGarmentProgressResult,
  type CustomerPortalBenefitsResult,
  type CustomerPortalGarmentsListResult,
  type CustomerPortalLoginInput,
  type CustomerPortalOrderGetResult,
  type CustomerPortalOrderSummary,
  type CustomerPortalProfileResult,
  type CustomerPortalProfileUpdateInput,
  type CustomerPortalReceiptResult,
  type CustomerPortalSession,
  type CustomerPortalWalletResult,
} from "@laundry/contracts";

import {
  createCustomerPortalAuthorityStore,
  customerPortalCookieSelector,
  type CustomerPortalAuthorityStore,
} from "./authority.js";

export type CustomerPortalFailure = Readonly<{ code: string; message: string }>;
export type CustomerPortalResult<T> =
  Readonly<{ ok: true; data: T }> | Readonly<{ ok: false; error: CustomerPortalFailure }>;

export type CustomerPortalClient = Readonly<{
  invalidateLocalSession(): void;
  resume(signal?: AbortSignal): Promise<CustomerPortalResult<CustomerPortalSession>>;
  login(
    input: CustomerPortalLoginInput,
    signal?: AbortSignal,
  ): Promise<CustomerPortalResult<CustomerPortalSession>>;
  logout(signal?: AbortSignal): Promise<CustomerPortalResult<Readonly<{ logged_out: true }>>>;
  listOrders(
    limit?: number,
    signal?: AbortSignal,
  ): Promise<CustomerPortalResult<readonly CustomerPortalOrderSummary[]>>;
  getWallet(signal?: AbortSignal): Promise<CustomerPortalResult<CustomerPortalWalletResult>>;
  getBenefits(signal?: AbortSignal): Promise<CustomerPortalResult<CustomerPortalBenefitsResult>>;
  getProfile(signal?: AbortSignal): Promise<CustomerPortalResult<CustomerPortalProfileResult>>;
  updateProfile(
    input: CustomerPortalProfileUpdateInput,
    signal?: AbortSignal,
  ): Promise<CustomerPortalResult<CustomerPortalProfileResult>>;
  getOrder(
    orderId: string,
    signal?: AbortSignal,
  ): Promise<CustomerPortalResult<CustomerPortalOrderGetResult>>;
  getReceipt(
    orderId: string,
    signal?: AbortSignal,
  ): Promise<CustomerPortalResult<CustomerPortalReceiptResult>>;
  listGarments(
    orderId: string,
    signal?: AbortSignal,
  ): Promise<CustomerPortalResult<CustomerPortalGarmentsListResult>>;
  getGarmentProgress(
    orderId: string,
    garmentId: string,
    signal?: AbortSignal,
  ): Promise<CustomerPortalResult<CustomerPortalGarmentProgressResult>>;
}>;

type HttpOptions = Readonly<{
  apiBaseUrl: string;
  fetchImpl?: typeof fetch;
  readCsrf?: (authority: string) => Promise<string | null> | string | null;
  authorityStore?: CustomerPortalAuthorityStore;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function defaultReadCsrf(authority: string): Promise<string | null> {
  if (typeof document === "undefined") return null;
  const selector = await customerPortalCookieSelector(authority);
  if (selector === null) return null;
  const secureNames = customerPortalCookieNames(selector, true);
  const localNames = customerPortalCookieNames(selector, false);
  if (secureNames === null || localNames === null) return null;
  const candidates = [secureNames.csrf, localNames.csrf] as const;
  const cookies = new Map(
    document.cookie.split(";").flatMap((entry) => {
      const value = entry.trim();
      const separator = value.indexOf("=");
      return separator < 1 ? [] : [[value.slice(0, separator), value.slice(separator + 1)]];
    }),
  );
  for (const name of candidates) {
    const value = cookies.get(name);
    if (value !== undefined) return value;
  }
  return null;
}

function failure(body: unknown, fallback: string): CustomerPortalFailure {
  if (!isRecord(body) || !isRecord(body.error)) {
    return Object.freeze({ code: "QUERY_FAILED", message: fallback });
  }
  return Object.freeze({
    code: typeof body.error.code === "string" ? body.error.code : "QUERY_FAILED",
    message: typeof body.error.message === "string" ? body.error.message : fallback,
  });
}

function parseData<T>(body: unknown, parse: (value: unknown) => T): CustomerPortalResult<T> {
  if (!isRecord(body) || body.ok !== true) {
    return Object.freeze({ ok: false as const, error: failure(body, "请求失败，请稍后重试") });
  }
  try {
    return Object.freeze({ ok: true as const, data: parse(body.data) });
  } catch {
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({ code: "INVALID_RESPONSE", message: "服务响应格式异常" }),
    });
  }
}

function executionResult(body: unknown): unknown {
  if (!isRecord(body) || !isRecord(body.data) || body.data.execution !== "executed") {
    throw new TypeError("Expected an executed query envelope");
  }
  return body.data.result;
}

export function createHttpCustomerPortalClient(options: HttpOptions): CustomerPortalClient {
  const base = options.apiBaseUrl.replace(/\/$/u, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const readCsrf = options.readCsrf ?? defaultReadCsrf;
  const authorityStore = options.authorityStore ?? createCustomerPortalAuthorityStore();

  const authenticationFailure = (): CustomerPortalResult<never> =>
    Object.freeze({
      ok: false as const,
      error: Object.freeze({ code: "AUTHENTICATION_FAILED", message: "请重新验证身份" }),
    });

  const request = async (
    path: string,
    init: Readonly<{
      method: "GET" | "POST";
      body?: unknown;
      csrf?: boolean;
      signal?: AbortSignal;
      authority: string;
    }>,
  ): Promise<unknown> => {
    const csrf = init.csrf === true ? await readCsrf(init.authority) : null;
    if (init.csrf === true && csrf === null) {
      return Object.freeze({
        ok: false,
        error: Object.freeze({ code: "CSRF_REJECTED", message: "会话校验已失效" }),
      });
    }
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method: init.method,
        credentials: "include",
        ...(init.signal === undefined ? {} : { signal: init.signal }),
        headers: Object.freeze({
          [CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME]: init.authority,
          ...(init.method === "POST"
            ? {
                "content-type": "application/json",
                ...(csrf === null ? {} : { "x-csrf-token": csrf }),
              }
            : {}),
        }),
        ...(init.method === "POST"
          ? {
              body: JSON.stringify(init.body ?? {}),
            }
          : {}),
      });
      return await response.json();
    } catch {
      return Object.freeze({
        ok: false,
        error: Object.freeze({ code: "NETWORK", message: "网络连接失败" }),
      });
    }
  };

  const query = async <T>(
    name: string,
    input: Readonly<Record<string, unknown>>,
    parse: (value: unknown) => T,
    signal?: AbortSignal,
  ): Promise<CustomerPortalResult<T>> => {
    const authority = authorityStore.current();
    if (authority === null) return authenticationFailure();
    const body = await request(`/v1/queries/${encodeURIComponent(name)}`, {
      method: "POST",
      body: input,
      csrf: true,
      authority,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!isRecord(body) || body.ok !== true) {
      const result = Object.freeze({ ok: false as const, error: failure(body, "查询失败") });
      if (result.error.code === "AUTHENTICATION_FAILED") authorityStore.clear(authority);
      return result;
    }
    try {
      return Object.freeze({ ok: true as const, data: parse(executionResult(body)) });
    } catch {
      return Object.freeze({
        ok: false as const,
        error: Object.freeze({ code: "INVALID_RESPONSE", message: "查询响应格式异常" }),
      });
    }
  };

  return Object.freeze({
    invalidateLocalSession() {
      const authority = authorityStore.current();
      if (authority !== null) authorityStore.clear(authority);
    },
    async resume(signal) {
      const authority = await authorityStore.claimCurrent();
      if (authority === null) return authenticationFailure();
      const result = parseData(
        await request("/api/v2/customer/auth/session", {
          method: "GET",
          authority,
          ...(signal === undefined ? {} : { signal }),
        }),
        (value) => CustomerPortalSessionSchema.parse(value),
      );
      if (!result.ok && result.error.code === "AUTHENTICATION_FAILED") {
        authorityStore.clear(authority);
      }
      return result;
    },
    async login(input, signal) {
      const parsed = CustomerPortalLoginInputSchema.safeParse(input);
      if (!parsed.success) {
        return Object.freeze({
          ok: false as const,
          error: Object.freeze({ code: "VALIDATION_FAILED", message: "请检查手机号和取件码" }),
        });
      }
      const authority = await authorityStore.issue();
      if (authority === null) {
        return Object.freeze({
          ok: false as const,
          error: Object.freeze({
            code: "AUTHORITY_UNAVAILABLE",
            message: "浏览器无法建立安全会话",
          }),
        });
      }
      const result = parseData(
        await request("/api/v2/customer/auth/login", {
          method: "POST",
          body: parsed.data,
          authority,
          ...(signal === undefined ? {} : { signal }),
        }),
        (value) => CustomerPortalSessionSchema.parse(value),
      );
      if (!result.ok) authorityStore.clear(authority);
      return result;
    },
    async logout(signal) {
      const authority = authorityStore.current();
      if (authority === null) return authenticationFailure();
      authorityStore.clear(authority);
      return parseData(
        await request("/api/v2/customer/auth/logout", {
          method: "POST",
          csrf: true,
          authority,
          ...(signal === undefined ? {} : { signal }),
        }),
        (value) => {
          if (!isRecord(value) || value.logged_out !== true) {
            throw new TypeError("Invalid logout response");
          }
          return Object.freeze({ logged_out: true as const });
        },
      );
    },
    async listOrders(limit = 20, signal) {
      return query(
        "customer.self_service.orders.list",
        { limit },
        (value) => Object.freeze([...CustomerPortalOrdersListResultSchema.parse(value).orders]),
        signal,
      );
    },
    async getWallet(signal) {
      return query(
        "customer.self_service.wallet.get",
        {},
        (value) => CustomerPortalWalletResultSchema.parse(value),
        signal,
      );
    },
    async getBenefits(signal) {
      return query(
        "customer.self_service.benefits.get",
        {},
        (value) => CustomerPortalBenefitsResultSchema.parse(value),
        signal,
      );
    },
    async getProfile(signal) {
      return query(
        "customer.self_service.profile.get",
        {},
        (value) => CustomerPortalProfileResultSchema.parse(value),
        signal,
      );
    },
    async updateProfile(input, signal) {
      const parsed = CustomerPortalProfileUpdateInputSchema.safeParse(input);
      const authority = authorityStore.current();
      if (!parsed.success) {
        return Object.freeze({
          ok: false as const,
          error: Object.freeze({ code: "VALIDATION_FAILED", message: "请检查地址和通知偏好" }),
        });
      }
      if (authority === null) return authenticationFailure();
      const result = parseData(
        await request("/api/v2/customer/profile", {
          method: "POST",
          body: parsed.data,
          csrf: true,
          authority,
          ...(signal === undefined ? {} : { signal }),
        }),
        (value) => CustomerPortalProfileMutationResultSchema.parse(value),
      );
      if (!result.ok && result.error.code === "AUTHENTICATION_FAILED") {
        authorityStore.clear(authority);
      }
      return result;
    },
    async getOrder(orderId, signal) {
      return query(
        "customer.self_service.order.get",
        { order_id: orderId },
        (value) => CustomerPortalOrderGetResultSchema.parse(value),
        signal,
      );
    },
    async getReceipt(orderId, signal) {
      return query(
        "customer.self_service.receipt.get",
        { order_id: orderId },
        (value) => CustomerPortalReceiptResultSchema.parse(value),
        signal,
      );
    },
    async listGarments(orderId, signal) {
      return query(
        "customer.self_service.garments.list",
        { order_id: orderId },
        (value) => CustomerPortalGarmentsListResultSchema.parse(value),
        signal,
      );
    },
    async getGarmentProgress(orderId, garmentId, signal) {
      return query(
        "customer.self_service.garment.progress",
        { order_id: orderId, garment_id: garmentId },
        (value) => CustomerPortalGarmentProgressResultSchema.parse(value),
        signal,
      );
    },
  });
}
