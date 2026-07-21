import { defineConfig } from "drizzle-kit";

/**
 * Formal v2 PostgreSQL schema only for packages/db.
 * Isolated from the root v1 desktop DB config under src/main.
 */
export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./src/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "postgresql://localhost:5432/laundry_v2",
  },
  strict: true,
  verbose: true,
});
