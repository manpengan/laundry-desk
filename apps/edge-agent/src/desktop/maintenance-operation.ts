import { z } from "zod";
import {
  DesktopMaintenanceInputSchema,
  DesktopMaintenanceResultSchema,
  MaintenanceHealthSchema,
  MaintenanceOpenedSchema,
} from "@laundry/contracts";
import { runWindowsMaintenance } from "../maintenance/windows-port.js";
import {
  AUTHENTICATION_FAILURE,
  RESOURCE_FAILURE,
  VALIDATION_FAILURE,
  isSameSession,
  type AuthState,
} from "./http-transport-support.js";
export const DESKTOP_MAINTENANCE_OPERATION = Object.freeze({
  input: DesktopMaintenanceInputSchema,
  result: DesktopMaintenanceResultSchema,
});
const RawHealth = MaintenanceHealthSchema.omit({ enabled: true })
  .extend({
    config: z.object({ enabled: z.boolean() }),
    latest: MaintenanceHealthSchema.shape.latest.unwrap().strip().nullable(),
  })
  .strip();
export function createDesktopMaintenanceOperation(
  currentState: () => AuthState | null,
  run = runWindowsMaintenance,
  now: () => number = Date.now,
) {
  let busy = false;
  return Object.freeze({
    async execute(raw: unknown): Promise<unknown> {
      const parsed = DesktopMaintenanceInputSchema.safeParse(raw);
      if (!parsed.success) return VALIDATION_FAILURE;
      const session = currentState();
      const authorized = () => {
        const current = currentState();
        return (
          session !== null &&
          current !== null &&
          current.expiresAtMs > now() &&
          isSameSession(session, current) &&
          session.sessionView.session.session_version ===
            current.sessionView.session.session_version &&
          session.sessionView.session.permission_version ===
            current.sessionView.session.permission_version &&
          (parsed.data.operation === "health" || current.sessionView.role === "admin")
        );
      };
      if (!authorized()) return AUTHENTICATION_FAILURE;
      if (busy) return RESOURCE_FAILURE;
      busy = true;
      try {
        const rawResult = await run(parsed.data, authorized);
        if (!authorized()) return AUTHENTICATION_FAILURE;
        if (parsed.data.operation !== "health")
          return { ok: true, data: MaintenanceOpenedSchema.parse(rawResult) };
        const result = RawHealth.parse(rawResult);
        const { config, ...summary } = result;
        return {
          ok: true,
          data: MaintenanceHealthSchema.parse({ ...summary, enabled: config.enabled }),
        };
      } catch {
        return RESOURCE_FAILURE;
      } finally {
        busy = false;
      }
    },
  });
}
