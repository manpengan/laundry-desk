import { pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";

/** Global-scope root tenant identity (A3 matrix: global). */
export const orgs = pgTable(
  "orgs",
  {
    id: uuid("id").primaryKey().notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [uniqueIndex("orgs_code_uidx").on(table.code)],
);
