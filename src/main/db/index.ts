import Database from "better-sqlite3";
import { app } from "electron";
import { join } from "path";
import { createDbClient, type AppDb } from "./client";
import * as schema from "./schema";

let db: AppDb | undefined;
let sqlite: Database.Database | undefined;

export function getDbPath(): string {
  const isDev = !app.isPackaged;
  return isDev
    ? join(process.cwd(), "laundry.db")
    : join(app.getPath("userData"), "laundry.db");
}

export function getDb(): AppDb {
  if (db) return db;

  sqlite = new Database(getDbPath());
  db = createDbClient(sqlite);
  return db;
}

export function getSqlite(): Database.Database {
  if (!sqlite) getDb();
  if (!sqlite) throw new Error("SQLite client is not initialized");
  return sqlite;
}

export function resetDbForTests(): void {
  sqlite?.close();
  sqlite = undefined;
  db = undefined;
}

export { createDbClient, schema };
export type { AppDb, AppTransaction, DbExecutor } from "./client";
