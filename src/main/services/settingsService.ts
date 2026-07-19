import { getDb, schema } from "../db";
import { eq } from "drizzle-orm";

export interface PriceTemplate {
  itemType: string;
  serviceType: "wash" | "dry_clean" | "iron";
  price: number; // 分
}

export class SettingsService {
  /**
   * 获取指定 key 的设置
   */
  static async get<T = any>(key: string, db = getDb()): Promise<T | null> {
    const setting = await db.query.settings.findFirst({
      where: eq(schema.settings.key, key),
    });
    if (!setting) return null;
    try {
      return JSON.parse(setting.value) as T;
    } catch {
      return setting.value as any;
    }
  }

  /**
   * 更新或创建设置
   */
  static async set(key: string, value: any, db = getDb()) {
    const valueStr = typeof value === "string" ? value : JSON.stringify(value);

    // 使用 ON CONFLICT DO UPDATE 逻辑
    const existing = await this.get(key, db);
    if (existing !== null) {
      await db
        .update(schema.settings)
        .set({ value: valueStr, updatedAt: new Date() })
        .where(eq(schema.settings.key, key));
    } else {
      await db.insert(schema.settings).values({
        key,
        value: valueStr,
      });
    }
    return value;
  }

  /**
   * 初始化默认设置
   */
  static async initDefaults() {
    const templates = await this.get("price_templates");
    if (!templates) {
      const defaultTemplates: PriceTemplate[] = [
        { itemType: "衬衫", serviceType: "wash", price: 1500 },
        { itemType: "西装", serviceType: "dry_clean", price: 4500 },
        { itemType: "大衣", serviceType: "dry_clean", price: 6000 },
        { itemType: "裤子", serviceType: "wash", price: 1500 },
        { itemType: "羽绒服", serviceType: "dry_clean", price: 8000 },
      ];
      await this.set("price_templates", defaultTemplates);
    }

    const shopName = await this.get("shop.name");
    if (!shopName) {
      await this.set("shop.name", "宏发洗衣店");
    }
  }
}
