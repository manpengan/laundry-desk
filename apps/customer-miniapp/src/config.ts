import { z } from "zod";

const Origin = z
  .string()
  .regex(/^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::443)?$/u)
  .refine(
    (value) =>
      !/(?:localhost|\.local)(?::443)?$/u.test(value) &&
      !/^https:\/\/[\d.]+(?::443)?$/u.test(value),
    "请配置已登记的 HTTPS 服务域名",
  );
export const MiniappConfigSchema = z.strictObject({
  apiOrigin: Origin,
});
export type MiniappConfig = z.infer<typeof MiniappConfigSchema>;

// Build-time public configuration. No key, token, customer or arbitrary URL from QR input.
declare const MINIAPP_PUBLIC_CONFIG: unknown;
export function loadPublicConfig(): MiniappConfig | null {
  const result = MiniappConfigSchema.safeParse(MINIAPP_PUBLIC_CONFIG);
  return result.success ? Object.freeze(result.data) : null;
}
