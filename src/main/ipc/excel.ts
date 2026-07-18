import { z } from "zod";
import { ExcelService } from "../services/excelService";
import { registerIpcHandler } from "./helpers";
import { app, dialog } from "electron";
import { join } from "path";

export function registerExcelIpc(): void {
  registerIpcHandler("excel:exportOrders", z.undefined(), async () => {
    const result = await dialog.showSaveDialog({
      title: "导出订单",
      defaultPath: join(
        app.getPath("downloads"),
        `orders-${new Date().getTime()}.xlsx`,
      ),
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
    });

    if (!result.canceled && result.filePath) {
      return await ExcelService.exportOrders(result.filePath);
    }
    return null;
  });

  registerIpcHandler("excel:exportCustomers", z.undefined(), async () => {
    const result = await dialog.showSaveDialog({
      title: "导出客户",
      defaultPath: join(
        app.getPath("downloads"),
        `customers-${new Date().getTime()}.xlsx`,
      ),
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
    });

    if (!result.canceled && result.filePath) {
      return await ExcelService.exportCustomers(result.filePath);
    }
    return null;
  });

  registerIpcHandler("excel:importCustomers", z.undefined(), async () => {
    const result = await dialog.showOpenDialog({
      title: "导入客户",
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
      properties: ["openFile"],
    });

    if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
      return await ExcelService.importCustomers(result.filePaths[0]);
    }
    return null;
  });

  registerIpcHandler("excel:importOrders", z.undefined(), async () => {
    const result = await dialog.showOpenDialog({
      title: "导入订单",
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
      properties: ["openFile"],
    });

    if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
      return await ExcelService.importOrders(result.filePaths[0]);
    }
    return null;
  });
}
