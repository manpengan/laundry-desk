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
  Readonly<{ ok: true; data: T }> | Readonly<{ ok: false; error: string }>;
type Schema<T> = Readonly<{
  safeParse: (value: unknown) => { success: true; data: T } | { success: false };
}>;
const failure = () => ({
  ok: false as const,
  error: "操作未确认。请刷新记录核对状态；检查管理员权限、当前版本及支付配置后再试。",
});
export function createPaymentChannelPort(operation: Operation) {
  async function execute<T>(
    input: DesktopPaymentChannelInput,
    schema: Schema<T>,
  ): Promise<ChannelResult<T>> {
    try {
      const parsed = DesktopPaymentChannelInputSchema.safeParse(input);
      if (!parsed.success) return failure();
      const result = DesktopPaymentChannelResultSchema.safeParse(await operation(parsed.data));
      if (!result.success || !result.data.ok) return failure();
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
  return async (raw) => {
    const input = DesktopPaymentChannelInputSchema.parse(raw);
    const route = paymentChannelRoute(input),
      token = options.getAccessToken(),
      csrf = options.readCsrf();
    if (!token || (route.method === "POST" && !csrf)) return null;
    const response = await options.fetchImpl(
      `${options.apiBaseUrl.replace(/\/$/u, "")}${route.path}`,
      {
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
      },
    );
    const body = await response.text();
    if (!response.ok || options.getAccessToken() !== token || body.length > 2_000_000) return null;
    return JSON.parse(body) as unknown;
  };
}
