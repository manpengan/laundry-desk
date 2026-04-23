import { z } from "zod";
import { ExcelService } from "../services/excelService";
import { registerIpcHandler } from "./helpers";

export function registerExcelIpc(): void {
  registerIpcHandler("excel:exportOrders", z.undefined(), () =>
    ExcelService.exportOrders(),
  );
  registerIpcHandler("excel:exportCustomers", z.undefined(), () =>
    ExcelService.exportCustomers(),
  );
}
