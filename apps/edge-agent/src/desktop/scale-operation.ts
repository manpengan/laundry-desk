import { z } from "zod";
import {
  DesktopScaleInputSchema,
  DesktopScaleResultSchema,
  ScalePortsSchema,
  ScaleReadingSchema,
  type DesktopScaleInput,
} from "@laundry/contracts";
import { parseScaleCapture } from "../scale/protocol.js";
import { readWindowsScale } from "../scale/windows-port.js";
import {
  AUTHENTICATION_FAILURE,
  RESOURCE_FAILURE,
  VALIDATION_FAILURE,
  isSameSession,
  type AuthState,
} from "./http-transport-support.js";

export const DESKTOP_SCALE_OPERATION = Object.freeze({
  input: DesktopScaleInputSchema,
  result: DesktopScaleResultSchema,
});
const CaptureSchema = z.strictObject({ capture: z.string().max(4096) });
export function createDesktopScaleOperation(
  currentState: () => AuthState | null,
  read: (input: DesktopScaleInput) => Promise<unknown> = readWindowsScale,
  now: () => number = Date.now,
) {
  let busy = false;
  let lastStarted = -Infinity;
  return Object.freeze({
    async execute(raw: unknown): Promise<unknown> {
      const parsed = DesktopScaleInputSchema.safeParse(raw);
      if (!parsed.success) return VALIDATION_FAILURE;
      const session = currentState();
      if (session === null || session.expiresAtMs <= now()) return AUTHENTICATION_FAILURE;
      if (busy || now() - lastStarted < 1000) return RESOURCE_FAILURE;
      busy = true;
      lastStarted = now();
      try {
        const result = await read(parsed.data);
        const current = currentState();
        if (current === null || current.expiresAtMs <= now() || !isSameSession(session, current))
          return AUTHENTICATION_FAILURE;
        if (parsed.data.operation === "ports")
          return { ok: true, data: ScalePortsSchema.parse(result) };
        const reading = parseScaleCapture(CaptureSchema.parse(result).capture);
        if (!reading) return RESOURCE_FAILURE;
        return {
          ok: true,
          data: ScaleReadingSchema.parse({
            ...reading,
            port: parsed.data.port,
            captured_at: now(),
            protocol: "and-standard-ascii-v1",
          }),
        };
      } catch {
        return RESOURCE_FAILURE;
      } finally {
        busy = false;
      }
    },
  });
}
