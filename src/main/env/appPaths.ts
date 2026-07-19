import { join } from "path";
import fs from "fs";

export function getDataDir(): string {
  const override = process.env.LAUNDRY_DATA_DIR;
  if (override && override.trim().length > 0) return override;
  if (process.versions.electron) {
    try {
      const electron = require("electron");
      return electron.app?.getPath("userData") ?? process.cwd();
    } catch {
      return process.cwd();
    }
  }
  return process.cwd();
}

export function ensureDataSubdir(name: string): string {
  const dir = join(getDataDir(), name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
