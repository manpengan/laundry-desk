import { SavePhotoSchema } from "../../shared/schemas";
import { getDb, schema } from "../db";
import { PhotoService } from "../services/photoService";
import { registerIpcHandler } from "./helpers";

export function registerPhotoIpc(): void {
  registerIpcHandler("photos:save", SavePhotoSchema, (input) => {
    const fileName = PhotoService.savePhoto(input.orderId, input.base64Data);
    return getDb()
      .insert(schema.orderPhotos)
      .values({
        orderId: input.orderId,
        filePath: fileName,
      })
      .returning()
      .get();
  });
}
