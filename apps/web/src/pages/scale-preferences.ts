import { ScaleReadInputSchema, type ScaleReadInput } from "@laundry/contracts";
import {
  readPreference,
  writePreference,
  type PreferenceStorage,
} from "./device-preference-storage.js";
export const SCALE_PREFERENCES_KEY = "laundry.scale.connection.v1";
export type ScalePreferences = Readonly<Pick<ScaleReadInput, "port" | "baud" | "framing">>;
export function readScalePreferences(
  storage?: PreferenceStorage | null,
): Readonly<{ value: ScalePreferences | null; error: string | null }> {
  const result = readPreference(SCALE_PREFERENCES_KEY, storage);
  if (result.value === null) return { value: null, error: result.error };
  const parsed = ScaleReadInputSchema.safeParse(result.value);
  return parsed.success
    ? {
        value: { port: parsed.data.port, baud: parsed.data.baud, framing: parsed.data.framing },
        error: null,
      }
    : { value: null, error: "已保存的电子秤通信设置无效，请重新选择并保存。" };
}
export function saveScalePreferences(
  value: unknown,
  storage?: PreferenceStorage | null,
): string | null {
  const parsed = ScaleReadInputSchema.safeParse(value);
  if (!parsed.success) return "请选择串口并核对秤上的通信参数。";
  // Serialize only the validated connection input; readings and staff/session data are never retained.
  return writePreference(SCALE_PREFERENCES_KEY, parsed.data, storage);
}
