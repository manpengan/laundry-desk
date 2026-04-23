import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import { join } from "path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createDbClient, type AppDb } from "@main/db";
import { BackupService } from "@main/services/backupService";
import { CustomerService } from "@main/services/customerService";
import { OrderService } from "@main/services/orderService";
import { PickupCodeService } from "@main/services/pickupCodeService";

describe("M1 services", () => {
  let sqlite: Database.Database;
  let db: AppDb;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = createDbClient(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("upserts customers by unique phone", async () => {
    const first = await CustomerService.upsertByPhone(
      "张三",
      "13800138000",
      db,
    );
    const second = await CustomerService.upsertByPhone(
      "张先生",
      "13800138000",
      db,
    );
    const customers = await db.query.customers.findMany();

    expect(second.id).toBe(first.id);
    expect(customers).toHaveLength(1);
    expect(customers[0].name).toBe("张先生");
  });

  it("generates four digit pickup codes including leading zeroes", () => {
    const code = PickupCodeService.generate(db);

    expect(code).toMatch(/^\d{4}$/);
  });

  it("creates orders transactionally and writes customer stats plus audit log", async () => {
    const customer = await CustomerService.upsertByPhone(
      "李四",
      "13900139000",
      db,
    );
    const order = OrderService.createOrder(
      {
        customerId: customer.id,
        items: [
          {
            itemType: "衬衫",
            serviceType: "wash",
            quantity: 2,
            unitPrice: 1500,
          },
        ],
        totalAmount: 3000,
        paidAmount: 1000,
        paymentMethod: "cash",
      },
      db,
    );
    const updatedCustomer = await db.query.customers.findFirst({
      where: (table, { eq }) => eq(table.id, customer.id),
    });
    const auditRows = await db.query.auditLog.findMany();

    expect(order.orderNo).toMatch(/^\d{8}-\d{4}$/);
    expect(order.pickupCode).toMatch(/^\d{4}$/);
    expect(updatedCustomer?.totalOrders).toBe(1);
    expect(updatedCustomer?.totalSpent).toBe(3000);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].action).toBe("create");
  });

  it("rejects orders whose submitted total does not match item subtotals", async () => {
    const customer = await CustomerService.upsertByPhone(
      "王五",
      "13700137000",
      db,
    );

    expect(() =>
      OrderService.createOrder(
        {
          customerId: customer.id,
          items: [
            {
              itemType: "西装",
              serviceType: "dry_clean",
              quantity: 1,
              unitPrice: 4500,
            },
          ],
          totalAmount: 4400,
          paidAmount: 4400,
          paymentMethod: "cash",
        },
        db,
      ),
    ).toThrow("订单总额与明细小计不一致");

    expect(await db.query.orders.findMany()).toHaveLength(0);
  });

  it("searches pickup candidates by code, phone, order number, and customer name", async () => {
    const customer = await CustomerService.upsertByPhone(
      "赵六",
      "13600136000",
      db,
    );
    const order = OrderService.createOrder(
      {
        customerId: customer.id,
        items: [
          {
            itemType: "裤子",
            serviceType: "wash",
            quantity: 1,
            unitPrice: 1500,
          },
        ],
        totalAmount: 1500,
        paidAmount: 1500,
        paymentMethod: "wechat",
      },
      db,
    );

    expect(OrderService.searchForPickup(order.pickupCode, db)[0].id).toBe(
      order.id,
    );
    expect(OrderService.searchForPickup("13600136000", db)[0].id).toBe(
      order.id,
    );
    expect(OrderService.searchForPickup(order.orderNo, db)[0].id).toBe(
      order.id,
    );
    expect(OrderService.searchForPickup("赵六", db)[0].id).toBe(order.id);
  });

  it("requires balance settlement before pickup and writes audit log", async () => {
    const customer = await CustomerService.upsertByPhone(
      "钱七",
      "13500135000",
      db,
    );
    const order = OrderService.createOrder(
      {
        customerId: customer.id,
        items: [
          {
            itemType: "大衣",
            serviceType: "dry_clean",
            quantity: 1,
            unitPrice: 6000,
          },
        ],
        totalAmount: 6000,
        paidAmount: 1000,
        paymentMethod: "cash",
      },
      db,
    );

    expect(() =>
      OrderService.pickup({ orderId: order.id, paidAmount: 1000 }, db),
    ).toThrow("订单仍有欠款");

    const pickedUp = OrderService.pickup(
      { orderId: order.id, paidAmount: 5000 },
      db,
    );
    const auditRows = await db.query.auditLog.findMany();

    expect(pickedUp?.status).toBe("picked_up");
    expect(pickedUp?.paidAmount).toBe(6000);
    expect(auditRows.map((row) => row.action)).toEqual(["create", "pickup"]);
  });

  it("returns live dashboard stats instead of placeholder values", async () => {
    const todayCustomer = await CustomerService.upsertByPhone(
      "今日客户",
      "13300133000",
      db,
    );
    const overdueCustomer = await CustomerService.upsertByPhone(
      "逾期客户",
      "13200132000",
      db,
    );
    const pickedUpCustomer = await CustomerService.upsertByPhone(
      "已取客户",
      "13100131000",
      db,
    );

    const dueToday = new Date();
    dueToday.setHours(18, 0, 0, 0);
    const overdueDate = new Date();
    overdueDate.setDate(overdueDate.getDate() - 1);
    overdueDate.setHours(18, 0, 0, 0);

    const todayOrder = OrderService.createOrder(
      {
        customerId: todayCustomer.id,
        items: [
          {
            itemType: "衬衫",
            serviceType: "wash",
            quantity: 2,
            unitPrice: 1200,
          },
        ],
        totalAmount: 2400,
        paidAmount: 2000,
        paymentMethod: "cash",
        expectedPickupDate: dueToday,
      },
      db,
    );

    OrderService.createOrder(
      {
        customerId: overdueCustomer.id,
        items: [
          {
            itemType: "大衣",
            serviceType: "dry_clean",
            quantity: 1,
            unitPrice: 5600,
          },
        ],
        totalAmount: 5600,
        paidAmount: 5600,
        paymentMethod: "wechat",
        expectedPickupDate: overdueDate,
      },
      db,
    );

    const pickedUpOrder = OrderService.createOrder(
      {
        customerId: pickedUpCustomer.id,
        items: [
          {
            itemType: "裤子",
            serviceType: "wash",
            quantity: 1,
            unitPrice: 1800,
          },
        ],
        totalAmount: 1800,
        paidAmount: 1800,
        paymentMethod: "cash",
      },
      db,
    );

    OrderService.pickup({ orderId: pickedUpOrder.id, paidAmount: 0 }, db);

    const stats = await OrderService.getStats(db);

    expect(stats.todayCount).toBe(3);
    expect(stats.pendingCount).toBe(2);
    expect(stats.overdueCount).toBe(1);
    expect(stats.dueTodayCount).toBe(1);
    expect(stats.todayIncome).toBe(9400);
    expect(stats.monthCount).toBeGreaterThanOrEqual(3);
    expect(stats.chartData).toHaveLength(7);
    expect(stats.chartData.at(-1)?.count).toBeGreaterThanOrEqual(3);
    expect(todayOrder.pickupCode).toMatch(/^\d{4}$/);
  });
});

describe("BackupService", () => {
  let tempDir: string;
  let sqlite: Database.Database;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(join(os.tmpdir(), "laundry-desk-test-"));
    sqlite = new Database(join(tempDir, "laundry.db"));
    const db = createDbClient(sqlite);
    await CustomerService.upsertByPhone("备份客户", "13400134000", db);
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes backup zip atomically and lists it newest first", async () => {
    const backupDir = join(tempDir, "backups");
    const zipPath = await BackupService.performBackup({
      dbPath: join(tempDir, "laundry.db"),
      backupDir,
      sqlite,
    });
    const backups = BackupService.listBackups(backupDir);

    expect(zipPath.endsWith(".zip")).toBe(true);
    expect(fs.existsSync(zipPath)).toBe(true);
    expect(
      fs.readdirSync(backupDir).some((file) => file.endsWith(".tmp")),
    ).toBe(false);
    expect(backups).toHaveLength(1);
    expect(backups[0].path).toBe(zipPath);
  });

  it("rotates backups and keeps the newest 30 files", () => {
    const backupDir = join(tempDir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });

    for (let index = 0; index < 35; index += 1) {
      const filePath = join(
        backupDir,
        `backup-2026-04-23-${index.toString().padStart(2, "0")}.zip`,
      );
      fs.writeFileSync(filePath, "zip");
      const time = new Date(2026, 3, 23, 3, index);
      fs.utimesSync(filePath, time, time);
    }

    BackupService.rotateBackups(backupDir);
    const backups = BackupService.listBackups(backupDir);

    expect(backups).toHaveLength(30);
    expect(backups[0].fileName).toBe("backup-2026-04-23-34.zip");
    expect(backups.at(-1)?.fileName).toBe("backup-2026-04-23-05.zip");
  });
});
