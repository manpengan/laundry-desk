import { join } from "path";
import fs from "fs";
import { ensureDataSubdir, getDataDir } from "../env/appPaths";

export class PhotoService {
  private static getPhotoDir() {
    const photoDir = ensureDataSubdir("photos");
    return photoDir;
  }

  private static getYearMonthStr() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    return `${year}-${month}`;
  }

  /**
   * 保存 Base64 图片，存为 YYYY-MM/orderNo_index.jpg 格式
   */
  static savePhoto(orderNo: string, index: number, base64Data: string): string {
    const yearMonth = this.getYearMonthStr();
    const photoDir = join(getDataDir(), "photos", yearMonth);
    if (!fs.existsSync(photoDir)) {
      fs.mkdirSync(photoDir, { recursive: true });
    }
    const fileName = `${orderNo}_${index}.jpg`;
    const filePath = join(photoDir, fileName);

    const data = base64Data.replace(/^data:image\/\w+;base64,/, "");
    const buf = Buffer.from(data, "base64");

    fs.writeFileSync(filePath, buf);
    return `${yearMonth}/${fileName}`; // 返回相对路径
  }

  /**
   * 获取照片绝对路径
   */
  static getPhotoPath(fileName: string) {
    return join(this.getPhotoDir(), fileName);
  }
}
