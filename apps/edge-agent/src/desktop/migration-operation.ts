import {
  DesktopV1MigrationInputSchema,
  DesktopV1MigrationResultSchema,
  type DesktopV1MigrationInput,
} from "@laundry/contracts";
import {
  AUTHENTICATION_FAILURE,
  RESOURCE_FAILURE,
  VALIDATION_FAILURE,
  isSameSession,
  type AuthState,
} from "./http-transport-support.js";
import type { DesktopHttpTransportDependencies } from "./http-transport-ports.js";
import { createDesktopRequest, type DesktopHttpRequest } from "./request-builder.js";

export const DESKTOP_MIGRATION_OPERATION = Object.freeze({
  input: DesktopV1MigrationInputSchema,
  result: DesktopV1MigrationResultSchema,
});
const CONTENT_TYPE = "application/vnd.laundry.v1-migration";
function requestFor(input: DesktopV1MigrationInput, state: AuthState): DesktopHttpRequest {
  const base = "/api/v2/migrations/v1/drafts";
  const credentials = { accessToken: state.accessToken, csrfToken: state.csrfToken };
  switch (input.operation) {
    case "draft":
      return createDesktopRequest("POST", base, {
        ...credentials,
        body: input.bytes,
        contentType: CONTENT_TYPE,
      });
    case "photo":
      return createDesktopRequest("POST", `${base}/${input.draft_id}/photos/${input.photo_id}`, {
        ...credentials,
        body: input.bytes,
        contentType: CONTENT_TYPE,
      });
    case "review":
      return createDesktopRequest("GET", `${base}/${input.draft_id}/review`, {
        accessToken: state.accessToken,
      });
    case "authorize":
      return createDesktopRequest("POST", `${base}/${input.draft_id}/authorize`, {
        ...credentials,
        body: input.body,
      });
  }
}
export function isMigrationBinaryUpload(url: URL, request: DesktopHttpRequest): boolean {
  if (
    request.method !== "POST" ||
    !(request.body instanceof Uint8Array) ||
    url.search !== "" ||
    request.headers["Content-Type"] !== CONTENT_TYPE ||
    request.body.byteLength < 1
  )
    return false;
  if (url.pathname === "/api/v2/migrations/v1/drafts")
    return request.body.byteLength <= 64 * 1024 * 1024;
  return (
    /^\/api\/v2\/migrations\/v1\/drafts\/[0-9a-f-]{36}\/photos\/[0-9a-f-]{36}$/u.test(
      url.pathname,
    ) && request.body.byteLength <= 8 * 1024 * 1024
  );
}

/** Finite domain capability. Renderer input cannot choose URLs/headers/tenant/path. */
export function createDesktopMigrationOperation(
  dependencies: Pick<DesktopHttpTransportDependencies, "request">,
  currentState: () => AuthState | null,
  refreshIfNeeded: (state: AuthState) => Promise<void> = async () => undefined,
) {
  return Object.freeze({
    async execute(raw: unknown): Promise<unknown> {
      const parsed = DesktopV1MigrationInputSchema.safeParse(raw);
      if (!parsed.success) return VALIDATION_FAILURE;
      const initial = currentState();
      if (!initial) return AUTHENTICATION_FAILURE;
      try {
        await refreshIfNeeded(initial);
        const state = currentState();
        if (!state || !isSameSession(initial, state)) return RESOURCE_FAILURE;
        const response = await dependencies.request(requestFor(parsed.data, state));
        const current = currentState();
        if (!current || !isSameSession(state, current)) return RESOURCE_FAILURE;
        const result = DesktopV1MigrationResultSchema.safeParse(JSON.parse(response.bodyText));
        return result.success ? result.data : RESOURCE_FAILURE;
      } catch {
        return RESOURCE_FAILURE;
      }
    },
  });
}
