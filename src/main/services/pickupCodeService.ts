import { and, eq, gte, lt } from "drizzle-orm";
import { getDb, schema, type DbExecutor } from "../db";
import { AppError } from "@shared/index";

export class PickupCodeService {
  static generate(db: DbExecutor = getDb(), now = new Date()): string {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const code = Math.floor(Math.random() * 10000)
        .toString()
        .padStart(4, "0");
      const existing = db
        .select({ id: schema.orders.id })
        .from(schema.orders)
        .where(
          and(
            eq(schema.orders.pickupCode, code),
            gte(schema.orders.receiveDate, today),
            lt(schema.orders.receiveDate, tomorrow),
          ),
        )
        .get();

      if (!existing) return code;
    }

    throw new AppError("INTERNAL_ERROR", "无法生成唯一的取件码，请重试");
  }
}
