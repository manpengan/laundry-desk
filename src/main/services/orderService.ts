import { and, desc, eq, gte, inArray, like, lt, or, sql } from "drizzle-orm";
import { getDb, schema, type DbExecutor } from "../db";
import { type CreateOrderInput, type PickupInput } from "../../shared/schemas";
import { AuditService } from "./auditService";
import { PickupCodeService } from "./pickupCodeService";

export interface OrderSearchResult {
  id: number;
  orderNo: string;
  pickupCode: string;
  status: string;
  totalAmount: number;
  paidAmount: number;
  receiveDate: Date;
  customerName: string;
  customerPhone: string;
}

interface ChartPoint {
  date: string;
  count: number;
  income: number;
}

export class OrderService {
  static generateOrderNo(db: DbExecutor = getDb(), now = new Date()): string {
    const dayStart = startOfDay(now);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const lastOrder = db
      .select({ orderNo: schema.orders.orderNo })
      .from(schema.orders)
      .where(
        and(
          gte(schema.orders.receiveDate, dayStart),
          lt(schema.orders.receiveDate, dayEnd),
        ),
      )
      .orderBy(desc(schema.orders.orderNo))
      .get();
    const nextNum = lastOrder ? Number(lastOrder.orderNo.split("-")[1]) + 1 : 1;

    if (nextNum > 9999) {
      throw new Error("今日订单号已达到 9999 上限");
    }

    return `${formatLocalDate(now)}-${nextNum.toString().padStart(4, "0")}`;
  }

  static createOrder(data: CreateOrderInput, db = getDb()) {
    const totalAmount = calculateTotal(data.items);
    if (totalAmount !== data.totalAmount) {
      throw new Error("订单总额与明细小计不一致");
    }
    if (data.paidAmount > data.totalAmount) {
      throw new Error("实收金额不能超过订单总额");
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return db.transaction((tx) => {
          const orderNo = OrderService.generateOrderNo(tx);
          const pickupCode = PickupCodeService.generate(tx);
          const order = tx
            .insert(schema.orders)
            .values({
              orderNo,
              pickupCode,
              customerId: data.customerId,
              totalAmount: data.totalAmount,
              paidAmount: data.paidAmount,
              paymentMethod: data.paymentMethod,
              expectedPickupDate: data.expectedPickupDate,
              notes: data.notes,
              staffId: data.staffId,
              status: "pending",
            })
            .returning()
            .get();

          data.items.forEach((item) => {
            tx.insert(schema.orderItems)
              .values({
                orderId: order.id,
                itemType: item.itemType,
                serviceType: item.serviceType,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
                subtotal: item.quantity * item.unitPrice,
                itemNotes: item.itemNotes,
              })
              .run();
          });

          tx.update(schema.customers)
            .set({
              totalOrders: sql`${schema.customers.totalOrders} + 1`,
              totalSpent: sql`${schema.customers.totalSpent} + ${data.totalAmount}`,
              updatedAt: new Date(),
            })
            .where(eq(schema.customers.id, data.customerId))
            .run();

          AuditService.log(
            {
              staffId: data.staffId,
              action: "create",
              entity: "orders",
              entityId: order.id,
              diff: {
                orderNo,
                pickupCode,
                totalAmount: data.totalAmount,
                paidAmount: data.paidAmount,
              },
            },
            tx,
          );

          return order;
        });
      } catch (error) {
        if (attempt < 4 && isUniqueConstraintError(error)) continue;
        throw error;
      }
    }

    throw new Error("订单创建失败，请重试");
  }

  static async findAll(
    params?: { limit?: number; offset?: number },
    db: DbExecutor = getDb(),
  ) {
    return await db.query.orders.findMany({
      limit: params?.limit ?? 50,
      offset: params?.offset ?? 0,
      orderBy: [desc(schema.orders.createdAt)],
      with: {
        customer: true,
        items: true,
      },
    });
  }

  static async findById(id: number, db: DbExecutor = getDb()) {
    return await db.query.orders.findFirst({
      where: eq(schema.orders.id, id),
      with: {
        customer: true,
        items: true,
        photos: true,
      },
    });
  }

  static searchForPickup(
    query: string,
    db: DbExecutor = getDb(),
  ): OrderSearchResult[] {
    const trimmed = query.trim();
    return db
      .select({
        id: schema.orders.id,
        orderNo: schema.orders.orderNo,
        pickupCode: schema.orders.pickupCode,
        status: schema.orders.status,
        totalAmount: schema.orders.totalAmount,
        paidAmount: schema.orders.paidAmount,
        receiveDate: schema.orders.receiveDate,
        customerName: schema.customers.name,
        customerPhone: schema.customers.phone,
      })
      .from(schema.orders)
      .innerJoin(
        schema.customers,
        eq(schema.orders.customerId, schema.customers.id),
      )
      .where(
        and(
          inArray(schema.orders.status, ["pending", "ready"]),
          or(
            eq(schema.orders.pickupCode, trimmed),
            eq(schema.orders.orderNo, trimmed),
            like(schema.customers.phone, `%${trimmed}%`),
            like(schema.customers.name, `%${trimmed}%`),
          ),
        ),
      )
      .orderBy(desc(schema.orders.receiveDate))
      .limit(30)
      .all();
  }

  static async getReport(
    params: { type: "daily" | "monthly" },
    db: DbExecutor = getDb(),
  ): Promise<ChartPoint[]> {
    const today = startOfDay(new Date());
    const result: ChartPoint[] = [];

    if (params.type === "daily") {
      const startDate = new Date(today);
      startDate.setDate(startDate.getDate() - 29);
      const endDate = new Date(today);
      endDate.setDate(endDate.getDate() + 1);

      const rows = db
        .select({
          dateStr: sql<string>`strftime('%Y-%m-%d', datetime(${schema.orders.receiveDate}, 'unixepoch', 'localtime'))`,
          count: sql<number>`count(*)`,
          income: sql<number>`sum(${schema.orders.paidAmount})`,
        })
        .from(schema.orders)
        .where(
          and(
            gte(schema.orders.receiveDate, startDate),
            lt(schema.orders.receiveDate, endDate),
          ),
        )
        .groupBy(
          sql`strftime('%Y-%m-%d', datetime(${schema.orders.receiveDate}, 'unixepoch', 'localtime'))`,
        )
        .all();

      const rowMap = new Map<string, { count: number; income: number }>();
      rows.forEach((row) => {
        rowMap.set(row.dateStr, {
          count: row.count,
          income: (row.income ?? 0) / 100,
        });
      });

      for (let i = 29; i >= 0; i -= 1) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const k = formatLocalDateStr(d);
        const val = rowMap.get(k) || { count: 0, income: 0 };
        result.push({
          date: d.toLocaleDateString("zh-CN", {
            month: "short",
            day: "numeric",
          }),
          count: val.count,
          income: val.income,
        });
      }
    } else {
      const startDate = new Date(today.getFullYear(), today.getMonth() - 11, 1);
      const endDate = new Date(today.getFullYear(), today.getMonth() + 1, 1);

      const rows = db
        .select({
          dateStr: sql<string>`strftime('%Y-%m', datetime(${schema.orders.receiveDate}, 'unixepoch', 'localtime'))`,
          count: sql<number>`count(*)`,
          income: sql<number>`sum(${schema.orders.paidAmount})`,
        })
        .from(schema.orders)
        .where(
          and(
            gte(schema.orders.receiveDate, startDate),
            lt(schema.orders.receiveDate, endDate),
          ),
        )
        .groupBy(
          sql`strftime('%Y-%m', datetime(${schema.orders.receiveDate}, 'unixepoch', 'localtime'))`,
        )
        .all();

      const rowMap = new Map<string, { count: number; income: number }>();
      rows.forEach((row) => {
        rowMap.set(row.dateStr, {
          count: row.count,
          income: (row.income ?? 0) / 100,
        });
      });

      for (let i = 11; i >= 0; i -= 1) {
        const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const k = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}`;
        const val = rowMap.get(k) || { count: 0, income: 0 };
        result.push({
          date: d.toLocaleDateString("zh-CN", {
            year: "numeric",
            month: "short",
          }),
          count: val.count,
          income: val.income,
        });
      }
    }

    return result;
  }

  static async getStats(db: DbExecutor = getDb()) {
    const today = startOfDay(new Date());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const todayOrders = await db.query.orders.findMany({
      where: gte(schema.orders.receiveDate, today),
    });
    const monthOrders = await db.query.orders.findMany({
      where: gte(schema.orders.receiveDate, monthStart),
    });
    const pendingOrders = await db.query.orders.findMany({
      where: inArray(schema.orders.status, ["pending", "ready"]),
    });

    const dailyReport = await this.getReport({ type: "daily" }, db);
    const chartData = dailyReport.slice(-7);

    return {
      todayIncome: todayOrders.reduce(
        (sum, order) => sum + order.paidAmount,
        0,
      ),
      monthIncome: monthOrders.reduce(
        (sum, order) => sum + order.paidAmount,
        0,
      ),
      todayCount: todayOrders.length,
      monthCount: monthOrders.length,
      pendingCount: pendingOrders.length,
      overdueCount: pendingOrders.filter(
        (order) =>
          order.expectedPickupDate !== null && order.expectedPickupDate < today,
      ).length,
      dueTodayCount: pendingOrders.filter(
        (order) =>
          order.expectedPickupDate !== null &&
          order.expectedPickupDate >= today &&
          order.expectedPickupDate < tomorrow,
      ).length,
      chartData,
    };
  }

  static pickup(input: PickupInput, db = getDb()) {
    return db.transaction((tx) => {
      const order = tx
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.id, input.orderId))
        .get();
      if (!order) throw new Error("订单不存在");
      if (order.status === "picked_up") throw new Error("订单已取件");
      if (order.status === "cancelled") throw new Error("订单已取消");

      const paidExtra = input.paidAmount ?? 0;
      const nextPaidAmount = order.paidAmount + paidExtra;
      if (nextPaidAmount > order.totalAmount) {
        throw new Error("实收金额不能超过订单总额");
      }
      if (nextPaidAmount < order.totalAmount) {
        throw new Error("订单仍有欠款，需结清后取件");
      }

      const updated = tx
        .update(schema.orders)
        .set({
          status: "picked_up",
          paidAmount: nextPaidAmount,
          actualPickupAt: new Date(),
          pickedUpBy: input.staffId,
          updatedAt: new Date(),
        })
        .where(eq(schema.orders.id, input.orderId))
        .returning()
        .get();

      AuditService.log(
        {
          staffId: input.staffId,
          action: "pickup",
          entity: "orders",
          entityId: input.orderId,
          diff: { paidExtra },
        },
        tx,
      );

      return updated;
    });
  }

  static async findOverdue(db: DbExecutor = getDb()) {
    return await db.query.orders.findMany({
      where: and(
        lt(schema.orders.expectedPickupDate, new Date()),
        eq(schema.orders.status, "pending"),
      ),
      with: { customer: true },
    });
  }
}

function calculateTotal(items: CreateOrderInput["items"]): number {
  return items.reduce(
    (total, item) => total + item.quantity * item.unitPrice,
    0,
  );
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}${month}${day}`;
}

function startOfDay(date: Date): Date {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("UNIQUE constraint failed")
  );
}

function formatLocalDateStr(date: Date): string {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}
