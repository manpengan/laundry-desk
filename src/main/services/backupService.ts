import { app } from "electron";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import archiver from "archiver";
import cron from "node-cron";
import type Database from "better-sqlite3";
import { getDbPath, getSqlite } from "../db";

export interface BackupOptions {
  dbPath?: string;
  backupDir?: string;
  sqlite?: Database.Database;
}

export interface BackupInfo {
  fileName: string;
  path: string;
  size: number;
  createdAt: string;
}

export class BackupService {
  static async performBackup(options: BackupOptions = {}): Promise<string> {
    const dbPath = options.dbPath ?? getDbPath();
    const backupDir = this.ensureBackupDir(options.backupDir);
    const sqlite = options.sqlite ?? getSqlite();

    if (!existsSync(dbPath)) {
      throw new Error(`数据库文件不存在: ${dbPath}`);
    }

    sqlite.pragma("wal_checkpoint(TRUNCATE)");

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const zipPath = join(backupDir, `backup-${timestamp}.zip`);
    const tempPath = `${zipPath}.tmp`;

    try {
      await writeZip(dbPath, tempPath);
      renameSync(tempPath, zipPath);
      this.rotateBackups(backupDir);
      return zipPath;
    } catch (error) {
      if (existsSync(tempPath)) unlinkSync(tempPath);
      throw error;
    }
  }

  static rotateBackups(backupDir = this.getBackupDir()): void {
    const files = this.listBackups(backupDir);

    files.slice(30).forEach((file) => {
      unlinkSync(file.path);
    });
  }

  static listBackups(backupDir = this.getBackupDir()): BackupInfo[] {
    if (!existsSync(backupDir)) return [];

    return readdirSync(backupDir)
      .filter((file) => file.startsWith("backup-") && file.endsWith(".zip"))
      .map((file) => {
        const filePath = join(backupDir, file);
        const stat = statSync(filePath);
        return {
          fileName: file,
          path: filePath,
          size: stat.size,
          createdAt: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  static initAutoBackup(): void {
    cron.schedule("0 3 * * *", async () => {
      try {
        await this.performBackup();
      } catch (error) {
        console.error("Auto backup failed:", error);
      }
    });
  }

  private static getBackupDir(): string {
    return join(app.getPath("userData"), "backups");
  }

  private static ensureBackupDir(backupDir = this.getBackupDir()): string {
    if (!existsSync(backupDir)) {
      mkdirSync(backupDir, { recursive: true });
    }
    return backupDir;
  }
}

function writeZip(dbPath: string, zipPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);
    archive.file(dbPath, { name: "laundry.db" });
    archive.finalize();
  });
}
