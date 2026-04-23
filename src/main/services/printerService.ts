import {
  PosPrinter,
  PosPrintData,
  PosPrintOptions,
} from "electron-pos-printer";
import { SettingsService } from "./settingsService";

export class PrinterService {
  /**
   * 打印收件登记单
   */
  static async printReceipt(order: any) {
    const shopName = (await SettingsService.get("shop.name")) || "洗衣店";

    const data: PosPrintData[] = [
      {
        type: "text",
        value: shopName,
        style: { fontWeight: "700", textAlign: "center", fontSize: "18px" },
      },
      {
        type: "text",
        value: "收件登记单",
        style: { textAlign: "center", fontSize: "12px", marginBottom: "10px" },
      },
      {
        type: "text",
        value: `订单号: ${order.orderNo}`,
        style: { fontSize: "12px" },
      },
      {
        type: "text",
        value: `取件码: ${order.pickupCode}`,
        style: {
          fontSize: "20px",
          fontWeight: "bold",
          textAlign: "center",
          margin: "10px 0",
        },
      },
      {
        type: "text",
        value: `客户: ${order.customer.name}`,
        style: { fontSize: "12px" },
      },
      {
        type: "text",
        value: `电话: ${order.customer.phone}`,
        style: { fontSize: "12px" },
      },
      {
        type: "text",
        value: "--------------------------------",
        style: { textAlign: "center" },
      },
    ];

    order.items.forEach((item: any) => {
      data.push({
        type: "text",
        value: `${item.itemType} x${item.quantity}  ¥${item.subtotal / 100}`,
        style: { fontSize: "12px" },
      });
    });

    data.push({
      type: "text",
      value: "--------------------------------",
      style: { textAlign: "center" },
    });
    data.push({
      type: "text",
      value: `总计: ¥${order.totalAmount / 100}`,
      style: { fontSize: "14px", fontWeight: "bold", textAlign: "right" },
    });
    data.push({
      type: "text",
      value: `日期: ${new Date().toLocaleString()}`,
      style: { fontSize: "10px", marginTop: "10px" },
    });
    data.push({
      type: "text",
      value: "谢谢惠顾，请妥善保管凭据",
      style: { fontSize: "10px", textAlign: "center", marginTop: "5px" },
    });

    const options: PosPrintOptions = {
      preview: false,
      width: "170px", // 58mm
      margin: "0 0 0 0",
      copies: 1,
      printerName: "", // 使用默认打印机
      timeOutPerLine: 400,
      silent: true,
    };

    try {
      await PosPrinter.print(data, options);
      return true;
    } catch (err) {
      console.error("打印失败:", err);
      return false;
    }
  }
}
