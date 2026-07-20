import { and, gte, inArray, lt, sql } from "drizzle-orm";
import { getDb, schema, type DbExecutor } from "../db";
import { type ReportDataDto, type StatsDto } from "../../shared";

export class ReportService {
  static async getReport(
    params: { type: "daily" | "monthly" },
    db: DbExecutor = getDb(),
  ): Promise<ReportDataDto[]> {
    const today = startOfDay(new Date());
    const result: ReportDataDto[] = [];

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

  static async getStats(db: DbExecutor = getDb()): Promise<StatsDto> {
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
}

function startOfDay(date: Date): Date {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
}

function formatLocalDateStr(date: Date): string {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}
