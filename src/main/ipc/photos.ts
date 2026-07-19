import { SavePhotoSchema } from "../../shared/schemas";
import { getDb, schema } from "../db";
import { PhotoService } from "../services/photoService";
import { registerIpcHandler } from "./helpers";
import { eq } from "drizzle-orm";

export function registerPhotoIpc(): void {
  registerIpcHandler("photos:save", SavePhotoSchema, async (input) => {
    const db = getDb();
    const order = db
      .select({ orderNo: schema.orders.orderNo })
      .from(schema.orders)
      .where(eq(schema.orders.id, input.orderId))
      .get();

    if (!order) {
      throw new Error(`找不到 ID 为 ${input.orderId} 的订单`);
    }

    const existing = db
      .select({ id: schema.orderPhotos.id })
      .from(schema.orderPhotos)
      .where(eq(schema.orderPhotos.orderId, input.orderId))
      .all();
    const nextIndex = existing.length + 1;

    const fileName = PhotoService.savePhoto(
      order.orderNo,
      nextIndex,
      input.base64Data,
    );
    return db
      .insert(schema.orderPhotos)
      .values({
        orderId: input.orderId,
        filePath: fileName,
      })
      .returning()
      .get();
  });
}
