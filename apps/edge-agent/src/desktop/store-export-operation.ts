import { DesktopStoreExportInputSchema, DesktopStoreExportResultSchema } from "@laundry/contracts";
import {
  AUTHENTICATION_FAILURE,
  RESOURCE_FAILURE,
  VALIDATION_FAILURE,
  isSameSession,
  type AuthState,
} from "./http-transport-support.js";
import type { DesktopHttpTransportDependencies } from "./http-transport-ports.js";
import { createDesktopRequest } from "./request-builder.js";
export const DESKTOP_STORE_EXPORT_OPERATION = Object.freeze({
  input: DesktopStoreExportInputSchema,
  result: DesktopStoreExportResultSchema,
});
export function createDesktopStoreExportOperation(
  dependencies: Pick<DesktopHttpTransportDependencies, "request">,
  currentState: () => AuthState | null,
  refreshIfNeeded: (state: AuthState) => Promise<void>,
) {
  return Object.freeze({
    async execute(raw: unknown): Promise<unknown> {
      const input = DesktopStoreExportInputSchema.safeParse(raw);
      if (!input.success) return VALIDATION_FAILURE;
      const initial = currentState();
      if (!initial) return AUTHENTICATION_FAILURE;
      try {
        await refreshIfNeeded(initial);
        const auth = currentState();
        if (!auth || !isSameSession(initial, auth)) return RESOURCE_FAILURE;
        const response = await dependencies.request(
          createDesktopRequest(
            input.data.operation === "preview" ? "GET" : "POST",
            "/api/v2/store-export",
            {
              accessToken: auth.accessToken,
              ...(input.data.operation === "authorize"
                ? { csrfToken: auth.csrfToken, body: input.data.body }
                : {}),
            },
          ),
        );
        const current = currentState();
        if (!current || !isSameSession(auth, current) || response.bodyText.length > 32768)
          return RESOURCE_FAILURE;
        const result = DesktopStoreExportResultSchema.safeParse(JSON.parse(response.bodyText));
        return result.success ? result.data : RESOURCE_FAILURE;
      } catch {
        return RESOURCE_FAILURE;
      }
    },
  });
}
