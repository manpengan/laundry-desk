import {
  DesktopPaymentChannelInputSchema,
  DesktopPaymentChannelResultSchema,
  PaymentChannelDataSchemas,
  paymentChannelRoute,
  paymentChannelResultMatches,
  type DesktopPaymentChannelInput,
} from "@laundry/contracts";

type Operation = (input: DesktopPaymentChannelInput) => Promise<unknown>;
export type ChannelResult<T> =
  Readonly<{ ok: true; data: T }> | Readonly<{ ok: false; error: string; code?: string }>;
type Schema<T> = Readonly<{
  safeParse: (value: unknown) => { success: true; data: T } | { success: false };
}>;
/** What staff can do about each server answer; never echoes server or provider text. */
const FAILURES: Readonly<Record<string, string>> = Object.freeze({
  AUTHENTICATION_FAILED: "登录已失效，请重新登录后再试。",
  PERMISSION_DENIED: "当前账号没有这项扫码收款操作的权限。",
  POLICY_DENIED: "需要店长账号，或管理员密码不正确。",
  RESOURCE_UNAVAILABLE:
    "这笔单现在不能这样操作：可能已有未结束的扫码收款、已经结清，或该渠道未启用。请刷新后再看。",
  IDEMPOTENCY_CONFLICT: "设置已被其他人修改，请刷新后重新操作。",
  VALIDATION_FAILED: "填写的内容不符合要求，请检查后重试。",
  RATE_LIMITED: "操作太频繁，请稍后再试。",
});
const UNCONFIRMED = "操作结果未确认：请刷新收款记录核对状态后再试，不要重复收款。";
const failure = (code?: string) => ({
  ok: false as const,
  error: (code === undefined ? undefined : FAILURES[code]) ?? UNCONFIRMED,
  ...(code === undefined ? {} : { code }),
});
export function createPaymentChannelPort(operation: Operation) {
  async function execute<T>(
    input: DesktopPaymentChannelInput,
    schema: Schema<T>,
  ): Promise<ChannelResult<T>> {
    try {
      const parsed = DesktopPaymentChannelInputSchema.safeParse(input);
      if (!parsed.success) return failure("VALIDATION_FAILED");
      const result = DesktopPaymentChannelResultSchema.safeParse(await operation(parsed.data));
      if (!result.success) return failure();
      if (!result.data.ok) return failure(result.data.error.code);
      if (!paymentChannelResultMatches(input, result.data.data)) return failure();
      const data = schema.safeParse(result.data.data);
      return data.success ? { ok: true, data: data.data } : failure();
    } catch {
      return failure();
    }
  }
  return Object.freeze({
    settings: () =>
      execute({ operation: "settings.get" }, PaymentChannelDataSchemas["settings.get"]),
    available: () => execute({ operation: "available" }, PaymentChannelDataSchemas.available),
    resolve: (body: Extract<DesktopPaymentChannelInput, { operation: "resolve" }>["body"]) =>
      execute({ operation: "resolve", body }, PaymentChannelDataSchemas.resolve),
    save: (body: Extract<DesktopPaymentChannelInput, { operation: "settings.save" }>["body"]) =>
      execute({ operation: "settings.save", body }, PaymentChannelDataSchemas["settings.save"]),
    checkout: (body: Extract<DesktopPaymentChannelInput, { operation: "checkout" }>["body"]) =>
      execute({ operation: "checkout", body }, PaymentChannelDataSchemas.checkout),
    list: (body: { order_id?: string } = {}) =>
      execute({ operation: "list", body }, PaymentChannelDataSchemas.list),
    status: (intent_id: string) =>
      execute({ operation: "status", body: { intent_id } }, PaymentChannelDataSchemas.status),
    close: (intent_id: string) =>
      execute({ operation: "close", body: { intent_id } }, PaymentChannelDataSchemas.close),
    refunds: (body: { order_id?: string } = {}) =>
      execute({ operation: "refunds.list", body }, PaymentChannelDataSchemas["refunds.list"]),
    refundStatus: (refund_id: string) =>
      execute(
        { operation: "refunds.status", body: { refund_id } },
        PaymentChannelDataSchemas["refunds.status"],
      ),
    reconcile: (body: Extract<DesktopPaymentChannelInput, { operation: "reconcile" }>["body"]) =>
      execute({ operation: "reconcile", body }, PaymentChannelDataSchemas.reconcile),
  });
}
export type PaymentChannelPort = ReturnType<typeof createPaymentChannelPort>;
export function createHttpPaymentChannelOperation(
  options: Readonly<{
    apiBaseUrl: string;
    fetchImpl: typeof fetch;
    getAccessToken: () => string | null;
    readCsrf: () => string | null;
  }>,
): Operation {
  // Call unbound: invoked as a method of options, a bare window.fetch throws Illegal invocation.
  const { fetchImpl } = options;
  return async (raw) => {
    const input = DesktopPaymentChannelInputSchema.parse(raw);
    const route = paymentChannelRoute(input),
      token = options.getAccessToken(),
      csrf = options.readCsrf();
    if (!token || (route.method === "POST" && !csrf)) return null;
    const response = await fetchImpl(`${options.apiBaseUrl.replace(/\/$/u, "")}${route.path}`, {
      method: route.method,
      credentials: "include",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${token}`,
        ...(csrf ? { "x-csrf-token": csrf } : {}),
        "content-type": "application/json",
      },
      ...("body" in input ? { body: JSON.stringify(input.body) } : {}),
    });
    const body = await response.text();
    if (options.getAccessToken() !== token || body.length > 2_000_000) return null;
    const value = JSON.parse(body) as unknown;
    // Non-2xx answers keep their error envelope so staff learn why; a 2xx failure is malformed.
    const isFailure =
      typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
    return response.ok !== isFailure ? value : null;
  };
}
