import { registerBackupIpc } from "./backup";
import { registerCustomerIpc } from "./customers";
import { registerExcelIpc } from "./excel";
import { registerOrderIpc } from "./orders";
import { registerPhotoIpc } from "./photos";
import { registerPrinterIpc } from "./printer";
import { registerSettingsIpc } from "./settings";

export function registerAllChannels(): void {
  registerOrderIpc();
  registerCustomerIpc();
  registerSettingsIpc();
  registerExcelIpc();
  registerPhotoIpc();
  registerPrinterIpc();
  registerBackupIpc();
}
