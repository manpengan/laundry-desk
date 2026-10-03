import { readFile, rm } from "node:fs/promises";
import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { extractV1Snapshot } from "../src/extract-v1.js";
import { createFixtureDatabase } from "./helpers.js";

describe("frozen historical source intake", () => {
  it("preserves staff/SMS/audit history without ever reading old password credentials", async () => {
    const f = await createFixtureDatabase();
    try {
      const db = new Database(f.path);
      db.exec(
        "CREATE TABLE staffs(id INTEGER,username TEXT,password_hash TEXT,display_name TEXT,role TEXT,is_active INTEGER,created_at INTEGER,last_login_at INTEGER); INSERT INTO staffs VALUES(1,'old-user','synthetic-never-import-password','旧员工','admin',1,NULL,NULL)",
      );
      db.exec(
        "CREATE TABLE sms_log(id INTEGER,order_id INTEGER,phone TEXT,content TEXT,status TEXT,provider_response TEXT,sent_at INTEGER); INSERT INTO sms_log VALUES(1,1,'13800000101','测试短信','sent',NULL,NULL)",
      );
      db.exec(
        "CREATE TABLE audit_log(id INTEGER,staff_id INTEGER,action TEXT,entity TEXT,entity_id INTEGER,diff TEXT,created_at INTEGER); INSERT INTO audit_log VALUES(1,1,'update','order',1,'测试差异',NULL)",
      );
      db.close();
      const before = await readFile(f.path);
      const snapshot = await extractV1Snapshot(f.path);
      expect(snapshot.history?.staffs).toHaveLength(1);
      expect(snapshot.history?.sms).toHaveLength(1);
      expect(snapshot.history?.audit).toHaveLength(1);
      expect(snapshot.history?.excluded_credential_count).toBe(1);
      expect(JSON.stringify(snapshot)).not.toContain("synthetic-never-import-password");
      expect(JSON.stringify(snapshot)).not.toContain("password_hash");
      expect(await readFile(f.path)).toEqual(before);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  });
  it("rejects unaccounted columns and tables", async () => {
    const f = await createFixtureDatabase();
    try {
      let db = new Database(f.path);
      db.exec("ALTER TABLE orders ADD COLUMN unaccounted TEXT");
      db.close();
      await expect(extractV1Snapshot(f.path)).rejects.toThrow();
      db = new Database(f.path);
      db.exec(
        "ALTER TABLE orders DROP COLUMN unaccounted; CREATE TABLE unknown_business(value TEXT)",
      );
      db.close();
      await expect(extractV1Snapshot(f.path)).rejects.toThrow();
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  });
});
