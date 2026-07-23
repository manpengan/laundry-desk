import {
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { staffs } from "./staffs.js";

/** Org-scoped encrypted BYOK material; the application never writes plaintext API keys here. */
export const aiCredentials = pgTable(
  "ai_credentials",
  {
    id: uuid("id").notNull(),
    orgId: uuid("org_id").notNull(),
    provider: text("provider").notNull(),
    keyCiphertext: text("key_ciphertext").notNull(),
    keyNonce: text("key_nonce").notNull(),
    keyTag: text("key_tag").notNull(),
    wrappedDek: text("wrapped_dek").notNull(),
    dekWrapNonce: text("dek_wrap_nonce").notNull(),
    dekWrapTag: text("dek_wrap_tag").notNull(),
    keyVersion: text("key_version").notNull(),
    last4: text("last4").notNull(),
    status: text("status").notNull(),
    createdByStaffId: uuid("created_by_staff_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: "ai_credentials_pkey" }),
    uniqueIndex("ai_credentials_org_id_uidx").on(table.orgId, table.id),
    index("ai_credentials_org_created_idx").on(table.orgId, table.createdAt, table.id),
    foreignKey({
      columns: [table.orgId, table.createdByStaffId],
      foreignColumns: [staffs.orgId, staffs.id],
      name: "ai_credentials_staff_fk",
    }),
  ],
);
