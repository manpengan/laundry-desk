import { ScaleReadingSchema, type ScaleReading } from "@laundry/contracts";
export function appendScaleReading(
  note: string,
  value: ScaleReading,
  now = Date.now(),
): string | null {
  const reading = ScaleReadingSchema.safeParse(value);
  if (!reading.success || now < value.captured_at || now - value.captured_at > 30000) return null;
  const basis = value.basis === "gross" ? "毛重" : value.basis === "net" ? "净重" : "重量";
  const line = `称重记录：${basis} ${value.grams} 克（${value.port}，${new Date(value.captured_at).toISOString()}）`;
  const result = [note, line].filter(Boolean).join("\n");
  return result.length <= 256 ? result : null;
}
