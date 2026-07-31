import { z } from "zod";

import { PhotoContentTypeSchema, PhotoUploadDataSchema } from "../commands/photo.js";
import { CommandResponseSchema } from "../envelope/responses.js";

export const DESKTOP_MAX_PHOTO_BYTES = 8 * 1_024 * 1_024;

const DesktopFailureResultSchema = CommandResponseSchema.options[1];
const createDesktopResultSchema = <TData extends z.ZodType>(data: TData) =>
  z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), data }),
    DesktopFailureResultSchema,
  ]);

export const DesktopPhotoUploadInputSchema = z
  .strictObject({
    upload_id: z.uuid(),
    order_id: z.uuid(),
    garment_id: z.uuid(),
    kind: z.enum(["receive", "defect", "ready", "other"]),
    content_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
    bytes: z.instanceof(Uint8Array),
    taken_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .superRefine((input, context) => {
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > DESKTOP_MAX_PHOTO_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Desktop photo bytes exceed the allowed range",
        path: ["bytes"],
      });
    }
  });
export const DesktopPhotoUploadResultSchema = createDesktopResultSchema(PhotoUploadDataSchema);
export const DesktopPhotoReadInputSchema = z.strictObject({
  photo_id: z.uuid(),
  variant: z.enum(["thumbnail", "original"]),
});
const DesktopPhotoBinaryDataSchema = z
  .strictObject({
    content_type: PhotoContentTypeSchema,
    bytes: z.instanceof(Uint8Array),
  })
  .superRefine((data, context) => {
    if (data.bytes.byteLength < 1 || data.bytes.byteLength > DESKTOP_MAX_PHOTO_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Desktop photo response exceeds the allowed range",
        path: ["bytes"],
      });
    }
  });
export const DesktopPhotoReadResultSchema = createDesktopResultSchema(DesktopPhotoBinaryDataSchema);
export const DesktopPhotoDeleteInputSchema = z.strictObject({
  photo_id: z.uuid(),
  delete_id: z.uuid(),
});
export const DesktopPhotoDeleteResultSchema = createDesktopResultSchema(PhotoUploadDataSchema);

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type DesktopPhotoUploadInput = DeepReadonly<z.output<typeof DesktopPhotoUploadInputSchema>>;
export type DesktopPhotoUploadResult = DeepReadonly<
  z.output<typeof DesktopPhotoUploadResultSchema>
>;
export type DesktopPhotoReadInput = DeepReadonly<z.output<typeof DesktopPhotoReadInputSchema>>;
export type DesktopPhotoReadResult = DeepReadonly<z.output<typeof DesktopPhotoReadResultSchema>>;
export type DesktopPhotoDeleteInput = DeepReadonly<z.output<typeof DesktopPhotoDeleteInputSchema>>;
export type DesktopPhotoDeleteResult = DeepReadonly<
  z.output<typeof DesktopPhotoDeleteResultSchema>
>;
