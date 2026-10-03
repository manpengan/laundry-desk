/** Local-only resize: no photo leaves the device before explicit analysis consent. */
export async function prepareVisionPhoto(file: File): Promise<string> {
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
    file.size < 1 ||
    file.size > 8 * 1024 * 1024
  )
    throw new Error("请选择 8 MiB 以内的 JPEG、PNG 或 WebP 衣物照片。");
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 16_000_000)
      throw new Error("照片分辨率过高，请先裁剪衣物区域。");
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前设备无法处理照片。");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const output = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("照片压缩失败。"))),
        "image/jpeg",
        0.65,
      ),
    );
    if (output.size > 147_456) throw new Error("照片细节过多，请裁剪后重试。");
    const bytes = new Uint8Array(await output.arrayBuffer());
    return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
  } finally {
    bitmap.close();
  }
}
