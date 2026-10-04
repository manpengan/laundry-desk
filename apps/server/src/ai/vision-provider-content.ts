import { z } from "zod";
import { ProviderAdapterError } from "./provider-types.js";
import type { AiProviderMessage } from "./streaming-provider.js";

export const ProviderImagesSchema = z
  .array(
    z
      .object({
        mediaType: z.literal("image/jpeg"),
        data: z
          .string()
          .min(4)
          .max(65_536)
          .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
      })
      .strict(),
  )
  .min(1)
  .max(3);
export type AiProviderImage = Readonly<z.output<typeof ProviderImagesSchema>[number]>;
export function messageImages(message: AiProviderMessage): readonly AiProviderImage[] {
  if (message.images === undefined) return [];
  const parsed = ProviderImagesSchema.safeParse(message.images);
  if (message.role !== "user" || !parsed.success)
    throw new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
  return parsed.data;
}
