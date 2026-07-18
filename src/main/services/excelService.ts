import ExcelJS from "exceljs";
import { getDb, schema } from "../db";
import { desc, eq, sql } from "drizzle-orm";

export class ExcelService {
  /**
   * 导出订单列表（平铺明细格式）
   */
  static async exportOrders(filePath: string, db = getDb()) {
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
      { header: "衣物类型", key: "itemType", width: 15 },
      { header: "服务类型", key: "serviceType", width: 10 },
      { header: "数量", key: "quantity", width: 8 },
      { header: "单价", key: "unitPrice", width: 10 },
    ];

    orders.forEach((order) => {
      if (order.items.length === 0) {
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
      } else {
        order.items.forEach((item, index) => {
          if (index === 0) {
            sheet.addRow({
              orderNo: order.orderNo,
              pickupCode: order.pickupCode,
              customerName: order.customer.name,
              customerPhone: order.customer.phone,
              totalAmount: order.totalAmount / 100,
              paidAmount: order.paidAmount / 100,
              status: order.status,
              receiveDate: new Date(order.receiveDate).toLocaleString(),
              itemType: item.itemType,
              serviceType: item.serviceType,
              quantity: item.quantity,
              unitPrice: item.unitPrice / 100,
            });
          } else {
            sheet.addRow({
              orderNo: order.orderNo,
              itemType: item.itemType,
              serviceType: item.serviceType,
              quantity: item.quantity,
              unitPrice: item.unitPrice / 100,
            });
          }
        });
      }
    });

    await workbook.xlsx.writeFile(filePath);
    return filePath;
  }

  /**
   * 导出客户列表
   */
  static async exportCustomers(filePath: string, db = getDb()) {
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

    await workbook.xlsx.writeFile(filePath);
    return filePath;
  }

  /**
   * 导入客户列表
   */
  static async importCustomers(filePath: string, db = getDb()) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.getWorksheet(1);
    if (!sheet) throw new Error("未找到有效的工作表");

    let successCount = 0;
    let skipCount = 0;

    db.transaction((tx) => {
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;

        const nameVal = row.getCell(1).value;
        const phoneVal = row.getCell(2).value;
        const vipVal = row.getCell(3).value;
        const ordersVal = row.getCell(4).value;
        const spentVal = row.getCell(5).value;

        if (!nameVal || !phoneVal) {
          skipCount += 1;
          return;
        }

        const name = String(nameVal).trim();
        const phone = String(phoneVal).trim().replace(/\s+/g, "");

        if (!/^1[3-9]\d{9}$/.test(phone)) {
          skipCount += 1;
          return;
        }

        const vipLevel = vipVal !== null ? Number(vipVal) || 0 : 0;
        const totalOrders = ordersVal !== null ? Number(ordersVal) || 0 : 0;
        const totalSpent =
          spentVal !== null ? Math.round(Number(spentVal) * 100) || 0 : 0;

        const existing = tx
          .select()
          .from(schema.customers)
          .where(eq(schema.customers.phone, phone))
          .get();

        if (existing) {
          tx.update(schema.customers)
            .set({
              name,
              vipLevel: Math.max(existing.vipLevel, vipLevel),
              totalOrders: existing.totalOrders + totalOrders,
              totalSpent: existing.totalSpent + totalSpent,
              updatedAt: new Date(),
            })
            .where(eq(schema.customers.id, existing.id))
            .run();
        } else {
          tx.insert(schema.customers)
            .values({
              name,
              phone,
              vipLevel,
              totalOrders,
              totalSpent,
            })
            .run();
        }
        successCount += 1;
      });
    });

    return { successCount, skipCount };
  }

  /**
   * 导入订单列表（平铺明细格式）
   */
  static async importOrders(filePath: string, db = getDb()) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.getWorksheet(1);
    if (!sheet) throw new Error("未找到有效的工作表");

    let successCount = 0;
    let skipCount = 0;

    const parsedOrders: any[] = [];
    let currentOrder: any = null;

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;

      const orderNoVal = row.getCell(1).value;
      const pickupCodeVal = row.getCell(2).value;
      const customerNameVal = row.getCell(3).value;
      const customerPhoneVal = row.getCell(4).value;
      const totalAmountVal = row.getCell(5).value;
      const paidAmountVal = row.getCell(6).value;
      const statusVal = row.getCell(7).value;
      const receiveDateVal = row.getCell(8).value;
      const itemTypeVal = row.getCell(9).value;
      const serviceTypeVal = row.getCell(10).value;
      const quantityVal = row.getCell(11).value;
      const unitPriceVal = row.getCell(12).value;

      if (orderNoVal) {
        const orderNo = String(orderNoVal).trim();
        currentOrder = {
          orderNo,
          pickupCode: pickupCodeVal
            ? String(pickupCodeVal).trim().slice(0, 4)
            : "0000",
          customerName: customerNameVal
            ? String(customerNameVal).trim()
            : "导入客户",
          customerPhone: customerPhoneVal
            ? String(customerPhoneVal).trim().replace(/\s+/g, "")
            : "",
          totalAmount:
            totalAmountVal !== null
              ? Math.round(Number(totalAmountVal) * 100)
              : 0,
          paidAmount:
            paidAmountVal !== null
              ? Math.round(Number(paidAmountVal) * 100)
              : 0,
          status: (statusVal ? String(statusVal).trim() : "pending") as any,
          receiveDate: receiveDateVal
            ? new Date(String(receiveDateVal))
            : new Date(),
          items: [],
        };

        if (
          !currentOrder.customerPhone ||
          !/^1[3-9]\d{9}$/.test(currentOrder.customerPhone)
        ) {
          currentOrder = null;
          skipCount += 1;
          return;
        }

        parsedOrders.push(currentOrder);
      }

      if (currentOrder && itemTypeVal) {
        const serviceType = (
          serviceTypeVal ? String(serviceTypeVal).trim() : "wash"
        ) as any;
        const validServiceTypes = ["wash", "dry_clean", "iron"];
        const finalServiceType = validServiceTypes.includes(serviceType)
          ? serviceType
          : "wash";

        currentOrder.items.push({
          itemType: String(itemTypeVal).trim(),
          serviceType: finalServiceType,
          quantity: quantityVal ? Number(quantityVal) || 1 : 1,
          unitPrice: unitPriceVal ? Math.round(Number(unitPriceVal) * 100) : 0,
        });
      }
    });

    db.transaction((tx) => {
      parsedOrders.forEach((pOrder) => {
        let customer = tx
          .select()
          .from(schema.customers)
          .where(eq(schema.customers.phone, pOrder.customerPhone))
          .get();

        if (!customer) {
          customer = tx
            .insert(schema.customers)
            .values({
              name: pOrder.customerName,
              phone: pOrder.customerPhone,
            })
            .returning()
            .get();
        }

        const existingOrder = tx
          .select()
          .from(schema.orders)
          .where(eq(schema.orders.orderNo, pOrder.orderNo))
          .get();

        if (existingOrder) {
          skipCount += 1;
          return;
        }

        const paymentMethod = pOrder.paidAmount === 0 ? "unpaid" : "cash";
        const order = tx
          .insert(schema.orders)
          .values({
            orderNo: pOrder.orderNo,
            pickupCode: pOrder.pickupCode,
            customerId: customer.id,
            totalAmount: pOrder.totalAmount,
            paidAmount: pOrder.paidAmount,
            paymentMethod,
            status: pOrder.status,
            receiveDate: pOrder.receiveDate,
          })
          .returning()
          .get();

        pOrder.items.forEach((item: any) => {
          tx.insert(schema.orderItems)
            .values({
              orderId: order.id,
              itemType: item.itemType,
              serviceType: item.serviceType,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              subtotal: item.quantity * item.unitPrice,
            })
            .run();
        });

        tx.update(schema.customers)
          .set({
            totalOrders: sql`${schema.customers.totalOrders} + 1`,
            totalSpent: sql`${schema.customers.totalSpent} + ${pOrder.totalAmount}`,
            updatedAt: new Date(),
          })
          .where(eq(schema.customers.id, customer.id))
          .run();

        tx.insert(schema.auditLog)
          .values({
            action: "import",
            entity: "orders",
            entityId: order.id,
            diff: JSON.stringify({
              orderNo: order.orderNo,
              totalAmount: order.totalAmount,
            }),
          })
          .run();

        successCount += 1;
      });
    });

    return { successCount, skipCount };
  }
}
