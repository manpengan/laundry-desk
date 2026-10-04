import {
  NotificationSettingsOperationSchema,
  NotificationSettingsResultSchema,
  type NotificationProviderSettingsRequest,
  type NotificationProviderSettingsView,
  type NotificationSettingsOperation,
} from "@laundry/contracts";

type Result =
  | Readonly<{ ok: true; data: NotificationProviderSettingsView }>
  | Readonly<{ ok: false; error: string }>;
type Operation = (input: NotificationSettingsOperation) => Promise<unknown>;
export type NotificationSettingsPort = Readonly<{
  read: () => Promise<Result>;
  save: (input: NotificationProviderSettingsRequest) => Promise<Result>;
}>;
export function createNotificationSettingsPort(operation: Operation): NotificationSettingsPort {
  const execute = async (input: NotificationSettingsOperation): Promise<Result> => {
    try {
      const parsed = NotificationSettingsOperationSchema.safeParse(input);
      if (!parsed.success) return { ok: false, error: "请检查短信签名、模板、费用及凭据格式。" };
      const result = NotificationSettingsResultSchema.safeParse(await operation(parsed.data));
      if (result.success && result.data.ok) return { ok: true, data: result.data.data };
      return {
        ok: false,
        error: "未完成设置。请检查管理员密码、当前版本，或先处理尚未结束的短信。",
      };
    } catch {
      return { ok: false, error: "短信设置暂不可用，请确认 Windows 服务已启动并重新登录。" };
    }
  };
  return Object.freeze({
    read: () => execute({ kind: "get" }),
    save: (input) => execute({ kind: "save", input }),
  });
}
export function createHttpNotificationSettingsOperation(
  options: Readonly<{
    apiBaseUrl: string;
    fetchImpl?: typeof fetch;
    getAccessToken: () => string | null;
    readCsrf: () => string | null;
  }>,
): Operation {
  return async (input) => {
    const token = options.getAccessToken();
    if (!token) throw new Error("AUTHENTICATION_FAILED");
    const csrf = options.readCsrf();
    if (input.kind === "save" && !csrf) throw new Error("CSRF_REJECTED");
    const response = await (options.fetchImpl ?? fetch)(
      `${options.apiBaseUrl}/api/v2/notification/provider-settings`,
      {
        method: input.kind === "get" ? "GET" : "POST",
        credentials: "include",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${token}`,
          ...(input.kind === "save"
            ? { "Content-Type": "application/json", "X-CSRF-Token": csrf! }
            : {}),
        },
        ...(input.kind === "save" ? { body: JSON.stringify(input.input) } : {}),
      },
    );
    const body = await response.text();
    if (body.length > 8192) throw new Error("RESPONSE_TOO_LARGE");
    return JSON.parse(body) as unknown;
  };
}
