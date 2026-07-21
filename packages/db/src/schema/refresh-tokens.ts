import {
  foreignKey,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { refreshFamilies } from "./refresh-families.js";
import { sessions } from "./sessions.js";
import { stores } from "./stores.js";

/**
 * Refresh token rows (A5). Store only token_hash — never the raw cookie secret.
 * status: active | rotated | revoked.
 */
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").notNull(),
    familyId: uuid("family_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull(),
    replacementTokenId: uuid("replacement_token_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: "refresh_tokens_pkey" }),
    uniqueIndex("refresh_tokens_tenant_id_uidx").on(table.orgId, table.storeId, table.id),
    uniqueIndex("refresh_tokens_hash_uidx").on(table.tokenHash),
    foreignKey({
      columns: [table.orgId, table.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: "refresh_tokens_store_fk",
    }),
    foreignKey({
      columns: [table.familyId],
      foreignColumns: [refreshFamilies.id],
      name: "refresh_tokens_family_fk",
    }),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [sessions.id],
      name: "refresh_tokens_session_fk",
    }),
  ],
);
