import {
  DesktopMiniappSettingsInputSchema,
  DesktopMiniappSettingsResultSchema,
} from "@laundry/contracts";
import {
  AUTHENTICATION_FAILURE,
  RESOURCE_FAILURE,
  VALIDATION_FAILURE,
  isSameSession,
  isSuccessStatus,
  type AuthState,
} from "./http-transport-support.js";
import type { DesktopHttpTransportDependencies } from "./http-transport-ports.js";
import { createDesktopRequest } from "./request-builder.js";
export const DESKTOP_MINIAPP_SETTINGS_OPERATION = Object.freeze({
  input: DesktopMiniappSettingsInputSchema,
  result: DesktopMiniappSettingsResultSchema,
});
export function createDesktopMiniappSettingsOperation(
  dependencies: Pick<DesktopHttpTransportDependencies, "request">,
  currentState: () => AuthState | null,
  refreshIfNeeded: (state: AuthState) => Promise<void>,
) {
  return Object.freeze({
    async execute(raw: unknown): Promise<unknown> {
      const input = DesktopMiniappSettingsInputSchema.safeParse(raw);
      if (!input.success) return VALIDATION_FAILURE;
      const initial = currentState();
      if (initial === null) return AUTHENTICATION_FAILURE;
      try {
        await refreshIfNeeded(initial);
        const auth = currentState();
        if (auth === null || !isSameSession(initial, auth)) return RESOURCE_FAILURE;
        const response = await dependencies.request(
          createDesktopRequest(
            input.data.operation === "read" ? "GET" : "POST",
            "/api/v2/miniapp/settings",
            {
              accessToken: auth.accessToken,
              ...(input.data.operation === "save"
                ? { csrfToken: auth.csrfToken, body: input.data.body }
                : {}),
            },
          ),
        );
        const current = currentState();
        if (current === null || !isSameSession(auth, current) || response.bodyText.length > 32768)
          return RESOURCE_FAILURE;
        const result = DesktopMiniappSettingsResultSchema.safeParse(JSON.parse(response.bodyText));
        return result.success && (!result.data.ok || isSuccessStatus(response.statusCode))
          ? result.data
          : RESOURCE_FAILURE;
      } catch {
        return RESOURCE_FAILURE;
      }
    },
  });
}
