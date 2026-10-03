import {
  DesktopMiniappSettingsInputSchema,
  DesktopMiniappSettingsResultSchema,
  type DesktopMiniappSettingsInput,
  type MiniappSettingsSave,
  type MiniappSettingsView,
} from "@laundry/contracts";
type Result =
  Readonly<{ ok: true; data: MiniappSettingsView }> | Readonly<{ ok: false; error: string }>;
type Operation = (input: DesktopMiniappSettingsInput) => Promise<unknown>;
export type MiniappSettingsPort = Readonly<{
  read: () => Promise<Result>;
  save: (input: MiniappSettingsSave) => Promise<Result>;
}>;
export function createMiniappSettingsPort(operation: Operation): MiniappSettingsPort {
  const execute = async (input: DesktopMiniappSettingsInput): Promise<Result> => {
    try {
      const parsed = DesktopMiniappSettingsResultSchema.safeParse(
        await operation(DesktopMiniappSettingsInputSchema.parse(input)),
      );
      if (parsed.success && parsed.data.ok) return parsed.data;
    } catch {
      /* Fixed failure copy never includes provider secrets. */
    }
    return {
      ok: false,
      error: "小程序配置未保存。请检查管理员密码、委托员工和本机密钥托管状态后重试。",
    };
  };
  return Object.freeze({
    read: () => execute({ operation: "read" }),
    save: (body) => execute({ operation: "save", body }),
  });
}
export function createHttpMiniappSettingsOperation(
  options: Readonly<{
    apiBaseUrl: string;
    fetchImpl: typeof fetch;
    getAccessToken: () => string | null;
    readCsrf: () => string | null;
  }>,
): Operation {
  return async (raw) => {
    const input = DesktopMiniappSettingsInputSchema.parse(raw);
    const token = options.getAccessToken(),
      csrf = options.readCsrf();
    if (!token || (input.operation === "save" && !csrf)) return null;
    const response = await options.fetchImpl(
      `${options.apiBaseUrl.replace(/\/$/u, "")}/api/v2/miniapp/settings`,
      {
        method: input.operation === "read" ? "GET" : "POST",
        credentials: "include",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${token}`,
          ...(input.operation === "save"
            ? { "x-csrf-token": csrf ?? "", "content-type": "application/json" }
            : {}),
        },
        ...(input.operation === "save" ? { body: JSON.stringify(input.body) } : {}),
      },
    );
    if (!response.ok || options.getAccessToken() !== token) return null;
    const body = await response.text();
    if (body.length > 32768 || options.getAccessToken() !== token) return null;
    return JSON.parse(body) as unknown;
  };
}
