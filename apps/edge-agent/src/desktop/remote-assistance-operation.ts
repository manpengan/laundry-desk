import {
  DesktopRemoteAssistanceInputSchema,
  DesktopRemoteAssistanceResultSchema,
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

export const DESKTOP_REMOTE_ASSISTANCE_OPERATION = Object.freeze({
  input: DesktopRemoteAssistanceInputSchema,
  result: DesktopRemoteAssistanceResultSchema,
});
export function createDesktopRemoteAssistanceOperation(
  dependencies: Pick<DesktopHttpTransportDependencies, "request">,
  currentState: () => AuthState | null,
  refreshIfNeeded: (state: AuthState) => Promise<void>,
) {
  return Object.freeze({
    async execute(raw: unknown): Promise<unknown> {
      const input = DesktopRemoteAssistanceInputSchema.safeParse(raw);
      if (!input.success) return VALIDATION_FAILURE;
      const initial = currentState();
      if (!initial) return AUTHENTICATION_FAILURE;
      try {
        await refreshIfNeeded(initial);
        const auth = currentState();
        if (!auth || !isSameSession(initial, auth)) return RESOURCE_FAILURE;
        const response = await dependencies.request(
          createDesktopRequest("POST", "/api/v2/remote-assistance", {
            accessToken: auth.accessToken,
            csrfToken: auth.csrfToken,
            body: input.data,
          }),
        );
        const current = currentState();
        if (!current || !isSameSession(auth, current) || response.bodyText.length > 32768)
          return RESOURCE_FAILURE;
        const result = DesktopRemoteAssistanceResultSchema.safeParse(JSON.parse(response.bodyText));
        if (result.success && result.data.ok && !isSuccessStatus(response.statusCode))
          return RESOURCE_FAILURE;
        return result.success ? result.data : RESOURCE_FAILURE;
      } catch {
        return RESOURCE_FAILURE;
      }
    },
  });
}
