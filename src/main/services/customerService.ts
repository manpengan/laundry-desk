import { desc, eq, like, or } from "drizzle-orm";
import { getDb, schema, type DbExecutor } from "../db";

export class CustomerService {
  static async upsertByPhone(
    name: string,
    phone: string,
    db: DbExecutor = getDb(),
  ) {
    const trimmedName = name.trim();
    const trimmedPhone = phone.trim();
    const existing = await db.query.customers.findFirst({
      where: eq(schema.customers.phone, trimmedPhone),
    });

    if (existing) {
      if (existing.name === trimmedName) return existing;

      return db
        .update(schema.customers)
        .set({ name: trimmedName, updatedAt: new Date() })
        .where(eq(schema.customers.id, existing.id))
        .returning()
        .get();
    }

    return db
      .insert(schema.customers)
      .values({
        name: trimmedName,
        phone: trimmedPhone,
      })
      .returning()
      .get();
  }

  static async findByPhone(phone: string, db: DbExecutor = getDb()) {
    return await db.query.customers.findFirst({
      where: eq(schema.customers.phone, phone.trim()),
    });
  }

  static async findAll(query?: string, db: DbExecutor = getDb()) {
    const trimmed = query?.trim();
    return await db.query.customers.findMany({
      where: trimmed
        ? or(
            like(schema.customers.name, `%${trimmed}%`),
            like(schema.customers.phone, `%${trimmed}%`),
          )
        : undefined,
      orderBy: [desc(schema.customers.updatedAt)],
      limit: 100,
    });
  }
}
