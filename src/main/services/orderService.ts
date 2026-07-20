import { and, desc, eq, gte, inArray, like, lt, or, sql } from "drizzle-orm";
import { getDb, schema, type DbExecutor } from "../db";
import { type CreateOrderInput, type PickupInput } from "../../shared/schemas";
import { AuditService } from "./auditService";
import { PickupCodeService } from "./pickupCodeService";
import { PhotoService } from "./photoService";
import { AppError } from "@shared/index";

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
      throw new AppError("INTERNAL_ERROR", "今日订单号已达到 9999 上限");
    }

    return `${formatLocalDate(now)}-${nextNum.toString().padStart(4, "0")}`;
  }

  static createOrder(data: CreateOrderInput, db = getDb()) {
    const totalAmount = calculateTotal(data.items);
    if (totalAmount !== data.totalAmount) {
      throw new AppError("VALIDATION_FAILED", "订单总额与明细小计不一致");
    }
    if (data.paidAmount > data.totalAmount) {
      throw new AppError("VALIDATION_FAILED", "实收金额不能超过订单总额");
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

          if (data.photos && data.photos.length > 0) {
            data.photos.forEach((base64Data, index) => {
              const fileName = PhotoService.savePhoto(
                orderNo,
                index + 1,
                base64Data,
              );
              tx.insert(schema.orderPhotos)
                .values({
                  orderId: order.id,
                  filePath: fileName,
                })
                .run();
            });
          }

          return order;
        });
      } catch (error) {
        if (attempt < 4 && isUniqueConstraintError(error)) continue;
        throw error;
      }
    }

    throw new AppError("INTERNAL_ERROR", "订单创建失败，请重试");
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

  static pickup(input: PickupInput, db = getDb()) {
    return db.transaction((tx) => {
      const order = tx
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.id, input.orderId))
        .get();
      if (!order) throw new AppError("NOT_FOUND", "订单不存在");
      if (order.status === "picked_up")
        throw new AppError("CONFLICT", "订单已取件");
      if (order.status === "cancelled")
        throw new AppError("CONFLICT", "订单已取消");

      const paidExtra = input.paidAmount ?? 0;
      const nextPaidAmount = order.paidAmount + paidExtra;
      if (nextPaidAmount > order.totalAmount) {
        throw new AppError("VALIDATION_FAILED", "实收金额不能超过订单总额");
      }
      if (nextPaidAmount < order.totalAmount) {
        throw new AppError("VALIDATION_FAILED", "订单仍有欠款，需结清后取件");
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
