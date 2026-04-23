import { z } from "zod";
import { BackupService } from "../services/backupService";
import { registerIpcHandler } from "./helpers";

export function registerBackupIpc(): void {
  registerIpcHandler("backup:runNow", z.undefined(), () =>
    BackupService.performBackup(),
  );
  registerIpcHandler("backup:list", z.undefined(), () =>
    BackupService.listBackups(),
  );
}
