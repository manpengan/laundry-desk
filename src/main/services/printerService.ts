import { SettingsService } from "./settingsService";
import {
  ElectronPosPrinterDriver,
  MockPrinterDriver,
  PrinterDriver,
} from "./printer/driver";

export class PrinterService {
  private static driver: PrinterDriver =
    process.platform === "win32" && process.env.NODE_ENV !== "test"
      ? new ElectronPosPrinterDriver()
      : new MockPrinterDriver();

  static setDriver(driver: PrinterDriver) {
    this.driver = driver;
  }

  /**
   * 打印收件登记单
   */
  static async printReceipt(order: any) {
    const shopName = (await SettingsService.get("shop.name")) || "洗衣店";
    const maskedPhone =
      order.customer.phone.length >= 7
        ? `${order.customer.phone.slice(0, 3)}****${order.customer.phone.slice(-4)}`
        : order.customer.phone;

    const data: any[] = [
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
        value: `电话: ${maskedPhone}`,
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

    const options = {
      preview: false,
      width: "170px", // 58mm
      margin: "0 0 0 0",
      copies: 1,
      printerName: "", // 使用默认打印机
      timeOutPerLine: 400,
      silent: true,
    };

    return await this.driver.print(data, options);
  }

  /**
   * 打印取件凭条
   */
  static async printPickupReceipt(order: any) {
    const shopName = (await SettingsService.get("shop.name")) || "洗衣店";
    const balance = order.totalAmount - order.paidAmount;
    const isSettled = balance <= 0;
    const maskedPhone =
      order.customer.phone.length >= 7
        ? `${order.customer.phone.slice(0, 3)}****${order.customer.phone.slice(-4)}`
        : order.customer.phone;

    const data: any[] = [
      {
        type: "text",
        value: shopName,
        style: { fontWeight: "700", textAlign: "center", fontSize: "18px" },
      },
      {
        type: "text",
        value: "取件凭条",
        style: { textAlign: "center", fontSize: "12px", marginBottom: "10px" },
      },
      {
        type: "text",
        value: `取件码: ${order.pickupCode}`,
        style: {
          fontSize: "24px",
          fontWeight: "bold",
          textAlign: "center",
          margin: "10px 0",
        },
      },
      {
        type: "text",
        value: `订单号: ${order.orderNo}`,
        style: { fontSize: "12px" },
      },
      {
        type: "text",
        value: `客户: ${order.customer.name}`,
        style: { fontSize: "12px" },
      },
      {
        type: "text",
        value: `电话: ${maskedPhone}`,
        style: { fontSize: "12px" },
      },
      {
        type: "text",
        value: "--------------------------------",
        style: { textAlign: "center" },
      },
      {
        type: "text",
        value: `应收金额: ¥${order.totalAmount / 100}`,
        style: { fontSize: "12px" },
      },
      {
        type: "text",
        value: `实收金额: ¥${order.paidAmount / 100}`,
        style: { fontSize: "12px" },
      },
      {
        type: "text",
        value: isSettled
          ? "付款状态: 【已结清】"
          : `付款状态: 【未结清，尚欠款 ¥${balance / 100}】`,
        style: {
          fontSize: "12px",
          fontWeight: "bold",
          textAlign: "center",
          margin: "8px 0",
        },
      },
      {
        type: "text",
        value: `打印时间: ${new Date().toLocaleString()}`,
        style: { fontSize: "10px", marginTop: "10px" },
      },
    ];

    const options = {
      preview: false,
      width: "170px",
      margin: "0 0 0 0",
      copies: 1,
      printerName: "",
      timeOutPerLine: 400,
      silent: true,
    };

    return await this.driver.print(data, options);
  }
}
