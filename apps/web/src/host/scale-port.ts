import {
  DesktopScaleInputSchema,
  DesktopScaleResultSchema,
  ScalePortsSchema,
  ScaleReadingSchema,
  type DesktopScaleInput,
  type ScaleReadInput,
  type ScaleReading,
} from "@laundry/contracts";
type Result<T> = Readonly<{ ok: true; data: T }> | Readonly<{ ok: false; error: string }>;
export type ScalePort = Readonly<{
  ports: () => Promise<Result<readonly string[]>>;
  read: (input: ScaleReadInput) => Promise<Result<ScaleReading>>;
}>;
const failure = (): Result<never> => ({
  ok: false,
  error: "电子秤未返回稳定读数。请检查串口、波特率与格式，待重量稳定后重试。",
});
export function createScalePort(
  operation: (input: DesktopScaleInput) => Promise<unknown>,
): ScalePort {
  const execute = async (input: DesktopScaleInput) => {
    try {
      const result = DesktopScaleResultSchema.safeParse(
        await operation(DesktopScaleInputSchema.parse(input)),
      );
      return result.success && result.data.ok ? result.data.data : null;
    } catch {
      return null;
    }
  };
  return Object.freeze({
    async ports() {
      const result = ScalePortsSchema.safeParse(await execute({ operation: "ports" }));
      return result.success ? { ok: true, data: result.data.ports } : failure();
    },
    async read(input) {
      const result = ScaleReadingSchema.safeParse(await execute(input));
      return result.success ? { ok: true, data: result.data } : failure();
    },
  });
}
