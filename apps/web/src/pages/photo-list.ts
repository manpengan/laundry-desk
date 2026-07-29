export type PhotoMetaRow = Readonly<{
  photo_id: string;
  garment_id: string;
  order_id: string;
  kind: string;
  content_type: string;
  byte_size: number;
  taken_at: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** Unwrap bus `{ execution, result }` or bare result. */
export function unwrapPhotoResult(data: unknown): unknown {
  if (!isRecord(data)) return data;
  if ("result" in data) return data.result;
  return data;
}

export function parsePhotoList(value: unknown): readonly PhotoMetaRow[] | null {
  if (!isRecord(value) || !Array.isArray(value.photos)) return null;
  const rows: PhotoMetaRow[] = [];
  for (const item of value.photos) {
    if (
      !isRecord(item) ||
      typeof item.photo_id !== "string" ||
      typeof item.garment_id !== "string" ||
      typeof item.order_id !== "string" ||
      typeof item.kind !== "string" ||
      typeof item.content_type !== "string"
    ) {
      return null;
    }
    const byteSize = asInt(item.byte_size);
    const takenAt = asInt(item.taken_at);
    if (byteSize === null || takenAt === null || byteSize < 1) return null;
    rows.push(
      Object.freeze({
        photo_id: item.photo_id,
        garment_id: item.garment_id,
        order_id: item.order_id,
        kind: item.kind,
        content_type: item.content_type,
        byte_size: byteSize,
        taken_at: takenAt,
      }),
    );
  }
  return Object.freeze(rows);
}
