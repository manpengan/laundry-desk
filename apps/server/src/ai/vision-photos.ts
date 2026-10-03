import sharp from "sharp";
import { z } from "zod";
import { AiVisionCandidatesResponseSchema, type AiVisionRequest } from "@laundry/contracts";
import { executeQuery } from "../bus/execute-query.js";
import { createRuntimeBus } from "../bus/runtime.js";
import { createSqlRunner } from "../http/bus-route-execution.js";
import type { LocalRuntime } from "../local/runtime-types.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import type { AiRequestContext } from "./streaming-store.js";
import type { AiProviderImage } from "./vision-provider-content.js";

export function assertVisionScope(context: AiRequestContext): void {
  if (
    context.tenant.orgId !== LOCAL_PROFILE.orgId ||
    context.tenant.storeId !== LOCAL_PROFILE.storeId ||
    !context.permissions?.includes("ai_use") ||
    !context.permissions.includes("order_write")
  )
    throw new Error("AI_VISION_DENIED");
}

export async function visionJpeg(bytes: Buffer, edge = 512): Promise<Buffer> {
  const decoder = sharp(bytes, { failOn: "error", limitInputPixels: 16_000_000, animated: false });
  const metadata = await decoder.metadata();
  if (!["jpeg", "png", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1)
    throw new Error("AI_VISION_IMAGE_INVALID");
  const image = await decoder
    .rotate()
    .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 65 })
    .toBuffer();
  if (image.length > (edge === 320 ? 24_576 : 49_152)) throw new Error("AI_VISION_IMAGE_TOO_LARGE");
  return image;
}

const workbench = z.object({
  garments: z
    .array(
      z.object({
        garment_id: z.uuid(),
        order_id: z.uuid(),
        ticket_no: z.string(),
        barcode: z.string(),
      }),
    )
    .max(10),
});
const photoType = z.enum(["image/jpeg", "image/png", "image/webp"]);
const checkCancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error("AI_ABORTED");
};

async function photoBytes(
  runtime: LocalRuntime,
  context: AiRequestContext,
  id: string,
  digest?: string,
) {
  const row = await runtime.photo.store.findById(context.tenant.orgId, context.tenant.storeId, id);
  if (
    runtime.photo.files == null ||
    row === null ||
    row.content_sha256 === null ||
    (digest !== undefined && row.content_sha256 !== digest)
  )
    throw new Error("AI_VISION_PHOTO_UNAVAILABLE");
  return {
    row,
    bytes: (
      await runtime.photo.files.read({
        storage_key: row.storage_key,
        content_type: photoType.parse(row.content_type),
        content_sha256: row.content_sha256,
        byte_size: row.byte_size,
      })
    ).bytes,
  };
}

export async function visionCandidates(
  runtime: LocalRuntime,
  context: AiRequestContext,
  key: string,
  signal?: AbortSignal,
) {
  assertVisionScope(context);
  checkCancelled(signal);
  const result = await createSqlRunner(runtime)((client) =>
    executeQuery(
      client,
      context.tenant,
      "fulfillment.workbench",
      { key, statuses: ["received", "washing", "ready", "racked", "reworked"], limit: 10 },
      {
        registry: createRuntimeBus(runtime).queryRegistry,
        actor: {
          staffId: context.tenant.staffId,
          deviceId: context.deviceId,
          via: "ai",
          riskCap: "R2",
          permissions: context.permissions ?? [],
        },
      },
    ),
  );
  if (!result.ok) throw new Error("AI_VISION_DENIED");
  const data = workbench.parse(result.data.result);
  const candidates = [];
  for (const garment of data.garments) {
    checkCancelled(signal);
    const photos = await runtime.photo.store.listByOrder(
      context.tenant.orgId,
      context.tenant.storeId,
      garment.order_id,
    );
    for (const photo of photos
      .filter((row) => row.garment_id === garment.garment_id && row.content_sha256 !== null)
      .slice(0, 2)) {
      const owned = await photoBytes(runtime, context, photo.photo_id);
      const thumbnail = await visionJpeg(owned.bytes, 320);
      checkCancelled(signal);
      candidates.push({
        photo_id: photo.photo_id,
        sha256: owned.row.content_sha256,
        ticket_no: garment.ticket_no,
        barcode: garment.barcode,
        thumbnail_base64: thumbnail.toString("base64"),
      });
      if (candidates.length === 6)
        return AiVisionCandidatesResponseSchema.parse({ ok: true, data: { candidates, limit: 6 } });
    }
  }
  return AiVisionCandidatesResponseSchema.parse({ ok: true, data: { candidates, limit: 6 } });
}

export async function prepareVisionImages(
  runtime: LocalRuntime,
  context: AiRequestContext,
  input: AiVisionRequest,
  signal?: AbortSignal,
): Promise<readonly AiProviderImage[]> {
  assertVisionScope(context);
  checkCancelled(signal);
  const raw = Buffer.from(input.image_base64, "base64");
  if (raw.toString("base64") !== input.image_base64 || raw.length > 147_456)
    throw new Error("AI_VISION_IMAGE_INVALID");
  const target = await visionJpeg(raw);
  const images: AiProviderImage[] = [{ mediaType: "image/jpeg", data: target.toString("base64") }];
  for (const item of input.candidates) {
    checkCancelled(signal);
    const owned = await photoBytes(runtime, context, item.photo_id, item.sha256);
    const jpeg = await visionJpeg(owned.bytes);
    images.push({ mediaType: "image/jpeg", data: jpeg.toString("base64") });
  }
  checkCancelled(signal);
  return Object.freeze(images);
}
