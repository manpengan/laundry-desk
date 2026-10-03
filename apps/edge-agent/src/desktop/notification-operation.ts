import {
  NotificationSettingsOperationSchema,
  NotificationSettingsResultSchema,
} from "@laundry/contracts";
import {
  AUTHENTICATION_FAILURE,
  RESOURCE_FAILURE,
  VALIDATION_FAILURE,
  isSameSession,
  type AuthState,
} from "./http-transport-support.js";
import type { DesktopHttpTransportDependencies } from "./http-transport-ports.js";
import { createDesktopRequest } from "./request-builder.js";

export const DESKTOP_NOTIFICATION_OPERATION = Object.freeze({
  input: NotificationSettingsOperationSchema,
  result: NotificationSettingsResultSchema,
});
/** Fixed authenticated settings operation; renderer cannot select a URL or credential scope. */
export function createDesktopNotificationOperation(
  dependencies: Pick<DesktopHttpTransportDependencies, "request">,
  currentState: () => AuthState | null,
  refreshIfNeeded: (state: AuthState) => Promise<void> = async () => undefined,
) {
  return Object.freeze({
    async execute(raw: unknown): Promise<unknown> {
      const input = NotificationSettingsOperationSchema.safeParse(raw);
      if (!input.success) return VALIDATION_FAILURE;
      const initial = currentState();
      if (initial === null) return AUTHENTICATION_FAILURE;
      try {
        await refreshIfNeeded(initial);
        const auth = currentState();
        if (auth === null || !isSameSession(initial, auth)) return RESOURCE_FAILURE;
        const response = await dependencies.request(
          createDesktopRequest(
            input.data.kind === "get" ? "GET" : "POST",
            "/api/v2/notification/provider-settings",
            {
              accessToken: auth.accessToken,
              ...(input.data.kind === "save"
                ? { csrfToken: auth.csrfToken, body: input.data.input }
                : {}),
            },
          ),
        );
        const current = currentState();
        if (current === null || !isSameSession(auth, current)) return RESOURCE_FAILURE;
        const result = NotificationSettingsResultSchema.safeParse(JSON.parse(response.bodyText));
        return result.success ? result.data : RESOURCE_FAILURE;
      } catch {
        return RESOURCE_FAILURE;
      }
    },
  });
}
