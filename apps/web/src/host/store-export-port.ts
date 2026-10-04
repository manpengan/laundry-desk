import {
  DesktopStoreExportInputSchema,
  DesktopStoreExportResultSchema,
  StoreExportPreviewSchema,
  StoreExportApprovedSchema,
  type DesktopStoreExportInput,
  type StoreExportApproval,
  type StoreExportPreview,
  type StoreExportApproved,
} from "@laundry/contracts";
type Result<T> = Readonly<{ ok: true; data: T }> | Readonly<{ ok: false; error: string }>;
type Operation = (input: DesktopStoreExportInput) => Promise<unknown>;
export type StoreExportPort = Readonly<{
  preview: () => Promise<Result<StoreExportPreview>>;
  authorize: (input: StoreExportApproval) => Promise<Result<StoreExportApproved>>;
}>;
const failure = (): Result<never> => ({
  ok: false,
  error: "未完成导出授权。请检查管理员密码、隐私管理员权限及服务状态，重新查看范围后重试。",
});
export function createStoreExportPort(operation: Operation): StoreExportPort {
  const execute = async (input: DesktopStoreExportInput) => {
    try {
      const response = DesktopStoreExportResultSchema.safeParse(
        await operation(DesktopStoreExportInputSchema.parse(input)),
      );
      return response.success && response.data.ok ? response.data.data : null;
    } catch {
      return null;
    }
  };
  return Object.freeze({
    async preview() {
      const result = StoreExportPreviewSchema.safeParse(await execute({ operation: "preview" }));
      return result.success ? { ok: true, data: result.data } : failure();
    },
    async authorize(body) {
      const result = StoreExportApprovedSchema.safeParse(
        await execute({ operation: "authorize", body }),
      );
      return result.success ? { ok: true, data: result.data } : failure();
    },
  });
}
export function createHttpStoreExportOperation(
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
    const input = DesktopStoreExportInputSchema.parse(raw);
    const token = options.getAccessToken();
    const csrf = options.readCsrf();
    if (!token || (input.operation === "authorize" && !csrf)) return null;
    const response = await fetchImpl(
      `${options.apiBaseUrl.replace(/\/$/u, "")}/api/v2/store-export`,
      {
        method: input.operation === "preview" ? "GET" : "POST",
        credentials: "include",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${token}`,
          ...(input.operation === "authorize"
            ? { "x-csrf-token": csrf!, "content-type": "application/json" }
            : {}),
        },
        ...(input.operation === "authorize" ? { body: JSON.stringify(input.body) } : {}),
      },
    );
    if (options.getAccessToken() !== token) return null;
    const body = await response.text();
    if (body.length > 32768) return null;
    return JSON.parse(body) as unknown;
  };
}
