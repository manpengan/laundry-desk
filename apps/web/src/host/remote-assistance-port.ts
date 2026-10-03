import {
  DesktopRemoteAssistanceInputSchema,
  DesktopRemoteAssistanceResultSchema,
  type DesktopRemoteAssistanceInput,
  type RemoteAssistanceAuthorize,
  type RemoteAssistanceStatus,
} from "@laundry/contracts";
type Result =
  Readonly<{ ok: true; data: RemoteAssistanceStatus }> | Readonly<{ ok: false; error: string }>;
type Operation = (input: DesktopRemoteAssistanceInput) => Promise<unknown>;
export type RemoteAssistancePort = Readonly<{
  status: () => Promise<Result>;
  authorize: (input: RemoteAssistanceAuthorize) => Promise<Result>;
  revoke: (sessionId: string) => Promise<Result>;
}>;
export function createRemoteAssistancePort(operation: Operation): RemoteAssistancePort {
  const execute = async (input: DesktopRemoteAssistanceInput): Promise<Result> => {
    try {
      const parsed = DesktopRemoteAssistanceResultSchema.safeParse(
        await operation(DesktopRemoteAssistanceInputSchema.parse(input)),
      );
      if (parsed.success && parsed.data.ok) return parsed.data;
    } catch {
      /* A transport/contract failure is shown as a fixed actionable message. */
    }
    return {
      ok: false,
      error:
        "协助操作未完成。请检查管理员密码和本机协助配置，再刷新状态；如需立即断开，也可关闭本机服务。",
    };
  };
  return Object.freeze({
    status: () => execute({ operation: "status" }),
    authorize: (body) => execute({ operation: "authorize", body }),
    revoke: (session_id) => execute({ operation: "revoke", body: { session_id } }),
  });
}
export function createHttpRemoteAssistanceOperation(
  options: Readonly<{
    apiBaseUrl: string;
    fetchImpl: typeof fetch;
    getAccessToken: () => string | null;
    readCsrf: () => string | null;
  }>,
): Operation {
  return async (raw) => {
    const input = DesktopRemoteAssistanceInputSchema.parse(raw);
    const token = options.getAccessToken(),
      csrf = options.readCsrf();
    if (!token || !csrf) return null;
    const response = await options.fetchImpl(
      `${options.apiBaseUrl.replace(/\/$/u, "")}/api/v2/remote-assistance`,
      {
        method: "POST",
        credentials: "include",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${token}`,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      },
    );
    if (options.getAccessToken() !== token) return null;
    const body = await response.text();
    if (body.length > 32768) return null;
    return JSON.parse(body) as unknown;
  };
}
