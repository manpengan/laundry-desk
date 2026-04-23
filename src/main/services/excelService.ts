import ExcelJS from "exceljs";
import { app, dialog } from "electron";
import { join } from "path";
import { getDb, schema } from "../db";
import { desc } from "drizzle-orm";

export class ExcelService {
  /**
   * 导出订单列表
   */
  static async exportOrders() {
    const db = getDb();
    const orders = await db.query.orders.findMany({
      orderBy: [desc(schema.orders.createdAt)],
      with: {
        customer: true,
        items: true,
      },
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("订单列表");

    sheet.columns = [
      { header: "订单号", key: "orderNo", width: 20 },
      { header: "取件码", key: "pickupCode", width: 10 },
      { header: "客户姓名", key: "customerName", width: 15 },
      { header: "客户电话", key: "customerPhone", width: 15 },
      { header: "总金额", key: "totalAmount", width: 12 },
      { header: "已付金额", key: "paidAmount", width: 12 },
      { header: "状态", key: "status", width: 10 },
      { header: "收件日期", key: "receiveDate", width: 20 },
    ];

    orders.forEach((order) => {
      sheet.addRow({
        orderNo: order.orderNo,
        pickupCode: order.pickupCode,
        customerName: order.customer.name,
        customerPhone: order.customer.phone,
        totalAmount: order.totalAmount / 100,
        paidAmount: order.paidAmount / 100,
        status: order.status,
        receiveDate: new Date(order.receiveDate).toLocaleString(),
      });
    });

    const result = await dialog.showSaveDialog({
      title: "导出订单",
      defaultPath: join(
        app.getPath("downloads"),
        `orders-${new Date().getTime()}.xlsx`,
      ),
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
    });

    if (!result.canceled && result.filePath) {
      await workbook.xlsx.writeFile(result.filePath);
      return result.filePath;
    }
    return null;
  }

  /**
   * 导出客户列表
   */
  static async exportCustomers() {
    const db = getDb();
    const customers = await db.query.customers.findMany({
      orderBy: [desc(schema.customers.totalSpent)],
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("客户列表");

    sheet.columns = [
      { header: "姓名", key: "name", width: 15 },
      { header: "电话", key: "phone", width: 15 },
      { header: "VIP 等级", key: "vipLevel", width: 10 },
      { header: "订单总数", key: "totalOrders", width: 12 },
      { header: "消费总额", key: "totalSpent", width: 12 },
      { header: "最后更新", key: "updatedAt", width: 20 },
    ];

    customers.forEach((customer) => {
      sheet.addRow({
        name: customer.name,
        phone: customer.phone,
        vipLevel: customer.vipLevel,
        totalOrders: customer.totalOrders,
        totalSpent: customer.totalSpent / 100,
        updatedAt: customer.updatedAt
          ? new Date(customer.updatedAt).toLocaleString()
          : "",
      });
    });

    const result = await dialog.showSaveDialog({
      title: "导出客户",
      defaultPath: join(
        app.getPath("downloads"),
        `customers-${new Date().getTime()}.xlsx`,
      ),
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
    });

    if (!result.canceled && result.filePath) {
      await workbook.xlsx.writeFile(result.filePath);
      return result.filePath;
    }
    return null;
  }
}
