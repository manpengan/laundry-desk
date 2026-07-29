import sharp from "sharp";

import { PhotoFileError } from "./file-store-error.js";
import type { PhotoContentType } from "./file-store.js";

const MAX_INPUT_PIXELS = 40_000_000;
const MAX_DIMENSION = 12_000;
const THUMBNAIL_EDGE = 320;

export type PhotoThumbnail = Readonly<{
  content_type: "image/webp";
  bytes: Buffer;
}>;

type SafeImageMetadata = Readonly<{
  format: string;
  width: number;
  height: number;
}>;

async function inspectSingleStillImage(bytes: Buffer): Promise<SafeImageMetadata> {
  try {
    const metadata = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
      sequentialRead: true,
      animated: false,
    }).metadata();
    const width = metadata.width;
    const height = metadata.height;
    if (
      width === undefined ||
      height === undefined ||
      width < 1 ||
      height < 1 ||
      width > MAX_DIMENSION ||
      height > MAX_DIMENSION ||
      metadata.format === undefined ||
      (metadata.pages ?? 1) !== 1
    ) {
      throw new Error("unsupported image geometry");
    }
    return Object.freeze({ format: metadata.format, width, height });
  } catch {
    throw new PhotoFileError("PHOTO_DECODE_INVALID", "photo cannot be decoded safely");
  }
}

function expectedFormat(contentType: PhotoContentType): "jpeg" | "png" | "webp" {
  if (contentType === "image/jpeg") return "jpeg";
  if (contentType === "image/png") return "png";
  return "webp";
}

export async function normalizePhoto(
  bytes: Buffer,
  declaredType: PhotoContentType,
): Promise<Readonly<{ content_type: PhotoContentType; bytes: Buffer }>> {
  const metadata = await inspectSingleStillImage(bytes);
  if (metadata.format !== expectedFormat(declaredType)) {
    throw new PhotoFileError("PHOTO_TYPE_INVALID", "photo bytes do not match content type");
  }
  try {
    const image = sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
      sequentialRead: true,
      animated: false,
    }).rotate();
    const normalized =
      declaredType === "image/jpeg"
        ? await image.jpeg({ quality: 92, progressive: false }).toBuffer()
        : declaredType === "image/png"
          ? await image.png({ compressionLevel: 9 }).toBuffer()
          : await image.webp({ quality: 90, effort: 4 }).toBuffer();
    return Object.freeze({ content_type: declaredType, bytes: normalized });
  } catch {
    throw new PhotoFileError("PHOTO_DECODE_INVALID", "photo normalization failed");
  }
}

/** Decode the full image before producing a bounded, metadata-free preview. */
export async function createPhotoThumbnail(bytes: Buffer): Promise<PhotoThumbnail> {
  await inspectSingleStillImage(bytes);
  try {
    const thumbnail = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
      sequentialRead: true,
      animated: false,
    })
      .rotate()
      .resize({
        width: THUMBNAIL_EDGE,
        height: THUMBNAIL_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 82, effort: 4 })
      .toBuffer();
    return Object.freeze({ content_type: "image/webp", bytes: thumbnail });
  } catch {
    throw new PhotoFileError("PHOTO_DECODE_INVALID", "photo thumbnail generation failed");
  }
}
