import {
  DesktopPaymentChannelInputSchema,
  DesktopPaymentChannelResultSchema,
  paymentChannelResultMatches,
  paymentChannelRoute,
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
export const DESKTOP_PAYMENT_CHANNEL_OPERATION = Object.freeze({
  input: DesktopPaymentChannelInputSchema,
  result: DesktopPaymentChannelResultSchema,
});
export function createDesktopPaymentChannelOperation(
  dependencies: Pick<DesktopHttpTransportDependencies, "request">,
  currentState: () => AuthState | null,
  refreshIfNeeded: (state: AuthState) => Promise<void>,
) {
  return Object.freeze({
    async execute(raw: unknown): Promise<unknown> {
      const input = DesktopPaymentChannelInputSchema.safeParse(raw);
      if (!input.success) return VALIDATION_FAILURE;
      const initial = currentState();
      if (!initial) return AUTHENTICATION_FAILURE;
      try {
        await refreshIfNeeded(initial);
        const auth = currentState();
        if (!auth || !isSameSession(initial, auth)) return RESOURCE_FAILURE;
        const route = paymentChannelRoute(input.data);
        const response = await dependencies.request(
          createDesktopRequest(route.method, route.path, {
            accessToken: auth.accessToken,
            csrfToken: auth.csrfToken,
            ...("body" in input.data ? { body: input.data.body } : {}),
          }),
        );
        const current = currentState();
        if (!current || !isSameSession(auth, current) || response.bodyText.length > 2_000_000)
          return RESOURCE_FAILURE;
        const result = DesktopPaymentChannelResultSchema.safeParse(JSON.parse(response.bodyText));
        if (!result.success) return RESOURCE_FAILURE;
        if (
          result.data.ok &&
          (!isSuccessStatus(response.statusCode) ||
            !paymentChannelResultMatches(input.data, result.data.data))
        )
          return RESOURCE_FAILURE;
        return result.data;
      } catch {
        return RESOURCE_FAILURE;
      }
    },
  });
}
