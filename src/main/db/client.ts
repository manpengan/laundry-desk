import { drizzle } from "drizzle-orm/better-sqlite3";
import type Database from "better-sqlite3";
import * as schema from "./schema";
import { migrate } from "./migrate";

export function createDbClient(sqlite: Database.Database) {
  migrate(sqlite);
  return drizzle(sqlite, { schema });
}

export type AppDb = ReturnType<typeof createDbClient>;
export type AppTransaction = Parameters<Parameters<AppDb["transaction"]>[0]>[0];
export type DbExecutor = AppDb | AppTransaction;
