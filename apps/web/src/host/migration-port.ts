import {
  DesktopV1MigrationInputSchema,
  DesktopV1MigrationResultSchema,
  V1MigrationPreviewSchema,
  V1MigrationReviewSchema,
  V1MigrationApprovedSchema,
  type DesktopV1MigrationInput,
  type V1MigrationPreview,
  type V1MigrationReview,
  type V1MigrationApproval,
  type V1MigrationApproved,
} from "@laundry/contracts";

export type MigrationResult<T> =
  Readonly<{ ok: true; data: T }> | Readonly<{ ok: false; error: string }>;
export type MigrationOperation = (input: DesktopV1MigrationInput) => Promise<unknown>;
export type MigrationPort = Readonly<{
  draft: (bytes: Uint8Array) => Promise<MigrationResult<V1MigrationPreview>>;
  photo: (draftId: string, photoId: string, bytes: Uint8Array) => Promise<MigrationResult<true>>;
  review: (draftId: string) => Promise<MigrationResult<V1MigrationReview>>;
  authorize: (
    draftId: string,
    input: V1MigrationApproval,
  ) => Promise<MigrationResult<V1MigrationApproved>>;
}>;
const failed = (): MigrationResult<never> => ({
  ok: false,
  error: "未完成操作。请检查管理员登录、所选文件及有效期后重试。",
});
export function createMigrationPort(operation: MigrationOperation): MigrationPort {
  async function execute(input: DesktopV1MigrationInput) {
    const parsed = DesktopV1MigrationInputSchema.safeParse(input);
    if (!parsed.success) return null;
    try {
      const result = DesktopV1MigrationResultSchema.safeParse(await operation(parsed.data));
      return result.success && result.data.ok ? result.data.data : null;
    } catch {
      return null;
    }
  }
  return Object.freeze({
    async draft(bytes) {
      const parsed = V1MigrationPreviewSchema.safeParse(
        await execute({ operation: "draft", bytes: Uint8Array.from(bytes) }),
      );
      return parsed.success ? { ok: true, data: parsed.data } : failed();
    },
    async photo(draft_id, photo_id, bytes) {
      const result = await execute({
        operation: "photo",
        draft_id,
        photo_id,
        bytes: Uint8Array.from(bytes),
      });
      return result && "uploaded" in result && result.uploaded
        ? { ok: true, data: true }
        : failed();
    },
    async review(draft_id) {
      const parsed = V1MigrationReviewSchema.safeParse(
        await execute({ operation: "review", draft_id }),
      );
      return parsed.success ? { ok: true, data: parsed.data } : failed();
    },
    async authorize(draft_id, body) {
      const parsed = V1MigrationApprovedSchema.safeParse(
        await execute({ operation: "authorize", draft_id, body }),
      );
      return parsed.success ? { ok: true, data: parsed.data } : failed();
    },
  });
}

/** Browser-host credentials remain in the transport closure, outside React. */
export function createHttpMigrationOperation(
  options: Readonly<{
    apiBaseUrl: string;
    fetchImpl: typeof fetch;
    getAccessToken: () => string | null;
    readCsrf: () => string | null;
  }>,
): MigrationOperation {
  return async (raw) => {
    const input = DesktopV1MigrationInputSchema.parse(raw);
    const token = options.getAccessToken();
    const csrf = options.readCsrf();
    if (!token || (input.operation !== "review" && !csrf)) return null;
    const base = "/api/v2/migrations/v1/drafts";
    const path =
      input.operation === "draft"
        ? base
        : input.operation === "photo"
          ? `${base}/${input.draft_id}/photos/${input.photo_id}`
          : `${base}/${input.draft_id}/${input.operation}`;
    const body =
      input.operation === "review"
        ? undefined
        : input.operation === "authorize"
          ? JSON.stringify(input.body)
          : Uint8Array.from(input.bytes);
    const response = await options.fetchImpl(`${options.apiBaseUrl.replace(/\/$/u, "")}${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      redirect: "error",
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined
          ? {}
          : {
              "x-csrf-token": csrf ?? "",
              "content-type":
                input.operation === "authorize"
                  ? "application/json"
                  : "application/vnd.laundry.v1-migration",
            }),
      },
      ...(body === undefined ? {} : { body }),
    });
    if (options.getAccessToken() !== token) return null;
    return response.json();
  };
}
