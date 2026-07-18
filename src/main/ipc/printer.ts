import { IdSchema } from "../../shared/schemas";
import { OrderService } from "../services/orderService";
import { PrinterService } from "../services/printerService";
import { registerIpcHandler } from "./helpers";

export function registerPrinterIpc(): void {
  registerIpcHandler("printer:printReceipt", IdSchema, async (orderId) => {
    const order = await OrderService.findById(orderId);
    if (!order) throw new Error("订单不存在");
    return await PrinterService.printReceipt(order);
  });

  registerIpcHandler("printer:printPickup", IdSchema, async (orderId) => {
    const order = await OrderService.findById(orderId);
    if (!order) throw new Error("订单不存在");
    return await PrinterService.printPickupReceipt(order);
  });
}
