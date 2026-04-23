import { app } from "electron";
import { join } from "path";
import fs from "fs";

export class PhotoService {
  private static getPhotoDir() {
    const photoDir = join(app.getPath("userData"), "photos");
    if (!fs.existsSync(photoDir)) {
      fs.mkdirSync(photoDir, { recursive: true });
    }
    return photoDir;
  }

  /**
   * 保存 Base64 图片
   */
  static savePhoto(orderId: number, base64Data: string) {
    const photoDir = this.getPhotoDir();
    const fileName = `order-${orderId}-${Date.now()}.jpg`;
    const filePath = join(photoDir, fileName);

    const data = base64Data.replace(/^data:image\/\w+;base64,/, "");
    const buf = Buffer.from(data, "base64");

    fs.writeFileSync(filePath, buf);
    return fileName; // 返回相对路径或文件名
  }

  /**
   * 获取照片绝对路径
   */
  static getPhotoPath(fileName: string) {
    return join(this.getPhotoDir(), fileName);
  }
}
