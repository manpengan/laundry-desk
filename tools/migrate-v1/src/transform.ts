import { createHash } from "node:crypto";
import { posix } from "node:path";

import type {
  MigratedCustomer,
  MigratedGarment,
  MigratedOrder,
  MigratedOrderLine,
  MigratedPayment,
  MigratedPhoto,
  MigratedSetting,
  MigrationGarmentStatus,
  MigrationOrderStatus,
  MigrationPaymentMethod,
  MigrationWarning,
  V1Customer,
  V1Order,
  V1OrderItem,
  V1OrderPhoto,
  V1Snapshot,
  V2MigrationPlan,
} from "./types.js";

/** Fixed historical fallback, used only when every v1 order timestamp is absent. */
export const LEGACY_MISSING_DATE_EPOCH = 946_684_800;

export class V1TransformError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "V1TransformError";
  }
}

function deterministicId(sourceHash: string, type: string, legacyId: number | string): string {
  const bytes = createHash("sha256").update(`${sourceHash}:${type}:${legacyId}`, "utf8").digest();
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new V1TransformError("unable to derive a deterministic migration identifier");
  }
  bytes[6] = (versionByte & 0x0f) | 0x50;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function checkedAdd(left: number, right: number, label: string): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) {
    throw new V1TransformError(`${label} exceeds safe integer cents`);
  }
  return total;
}

function expectedLineTotal(quantity: number, unitPriceCents: number): number {
  const total = quantity * unitPriceCents;
  if (!Number.isSafeInteger(total)) {
    throw new V1TransformError("v1 line total exceeds safe integer cents");
  }
  return total;
}

function mapOrderStatus(status: V1Order["status"]): MigrationOrderStatus {
  switch (status) {
    case "pending":
    case "ready":
      return "open";
    case "picked_up":
      return "closed";
    case "cancelled":
      return "cancelled";
  }
}

function mapGarmentStatus(status: V1Order["status"]): MigrationGarmentStatus {
  switch (status) {
    case "ready":
      return "ready";
    case "picked_up":
      return "picked_up";
    case "pending":
    case "cancelled":
      return "received";
  }
}

function mapPaymentMethod(method: V1Order["paymentMethod"]): MigrationPaymentMethod {
  if (method === "cash" || method === "wechat" || method === "alipay") return method;
  return "other";
}

function dateFor(
  order: V1Order,
  field: "createdAt" | "updatedAt",
  warnings: MigrationWarning[],
): number {
  const direct = order[field];
  if (direct !== null) return direct;
  const fallback =
    field === "createdAt"
      ? (order.receiveAt ?? order.expectedPickupAt ?? order.actualPickupAt)
      : (order.actualPickupAt ?? order.receiveAt ?? order.expectedPickupAt);
  warnings.push(Object.freeze({ code: "MISSING_DATE_DEFAULTED", legacyOrderId: order.id, field }));
  return fallback ?? LEGACY_MISSING_DATE_EPOCH;
}

function normalizeLegacyPhotoPath(filePath: string): string {
  const normalized = posix.normalize(filePath.replaceAll("\\", "/"));
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    normalized.includes("\u0000")
  ) {
    throw new V1TransformError("v1 photo path is not a safe relative asset path");
  }
  return normalized;
}

function toJsonValue(value: string): string {
  try {
    JSON.parse(value) as unknown;
    return value;
  } catch {
    return JSON.stringify(value);
  }
}

function assertOrderAmountInvariant(order: V1Order, sourceLineTotal: number): void {
  if (order.paidCents > order.totalCents) {
    throw new V1TransformError(`v1 order ${order.id} paid amount exceeds total`);
  }
  if (sourceLineTotal !== order.totalCents) {
    throw new V1TransformError(`v1 order ${order.id} total does not equal its item subtotals`);
  }
  if (order.status === "picked_up" && order.paidCents !== order.totalCents) {
    throw new V1TransformError(`v1 picked-up order ${order.id} has a remaining balance`);
  }
}

type OrderContents = Readonly<{
  lines: readonly MigratedOrderLine[];
  garments: readonly MigratedGarment[];
  subtotalCents: number;
}>;

type TransformState = Readonly<{
  sourceHash: string;
  customerByLegacyId: ReadonlyMap<number, V1Customer>;
  itemsByOrderId: ReadonlyMap<number, readonly V1OrderItem[]>;
  warnings: MigrationWarning[];
  seenTicketNumbers: Set<string>;
  seenBarcodes: Set<string>;
}>;

function indexItems(items: readonly V1OrderItem[]): ReadonlyMap<number, readonly V1OrderItem[]> {
  const byOrderId = new Map<number, readonly V1OrderItem[]>();
  for (const item of items) {
    const existing = byOrderId.get(item.orderId) ?? [];
    byOrderId.set(item.orderId, Object.freeze([...existing, item]));
  }
  return byOrderId;
}

function transformCustomers(snapshot: V1Snapshot): readonly MigratedCustomer[] {
  return Object.freeze(
    snapshot.customers.map((customer) => {
      const createdAt = customer.createdAt ?? LEGACY_MISSING_DATE_EPOCH;
      return Object.freeze({
        id: deterministicId(snapshot.sourceBackupSha256, "customer", customer.id),
        legacyCustomerId: customer.id,
        phone: customer.phone,
        name: customer.name,
        createdAt,
        updatedAt: customer.updatedAt ?? createdAt,
        legacyVipLevel: customer.vipLevel,
        legacyTotalOrders: customer.totalOrders,
        legacyTotalSpentCents: customer.totalSpentCents,
      });
    }),
  );
}

function transformLine(
  item: V1OrderItem,
  lineIndex: number,
  sourceHash: string,
): MigratedOrderLine {
  const computedTotal = expectedLineTotal(item.quantity, item.unitPriceCents);
  if (computedTotal !== item.subtotalCents) {
    throw new V1TransformError(`v1 order item ${item.id} subtotal does not equal qty × unit price`);
  }
  return Object.freeze({
    id: deterministicId(sourceHash, "order-line", item.id),
    legacyOrderItemId: item.id,
    lineIndex,
    serviceCode: item.serviceType,
    categoryCode: `legacy-item-${item.id}`,
    unitPriceCents: item.unitPriceCents,
    qty: item.quantity,
    lineTotalCents: item.subtotalCents,
    legacyItemType: item.itemType,
    legacyItemNotes: item.itemNotes,
  });
}

function appendGarments(
  garments: MigratedGarment[],
  sourceOrder: V1Order,
  sourceItem: V1OrderItem,
  line: MigratedOrderLine,
  state: TransformState,
): void {
  for (let seq = 1; seq <= sourceItem.quantity; seq += 1) {
    const barcode = `V1-${sourceOrder.id}-${sourceItem.id}-${seq}`;
    if (state.seenBarcodes.has(barcode)) {
      throw new V1TransformError("generated a duplicate v2 garment barcode");
    }
    state.seenBarcodes.add(barcode);
    garments.push(
      Object.freeze({
        id: deterministicId(state.sourceHash, "garment", `${sourceItem.id}:${seq}`),
        orderId: deterministicId(state.sourceHash, "order", sourceOrder.id),
        orderLineId: line.id,
        lineIndex: line.lineIndex,
        seq,
        barcode,
        serviceCode: line.serviceCode,
        categoryCode: line.categoryCode,
        unitPriceCents: line.unitPriceCents,
        status: mapGarmentStatus(sourceOrder.status),
      }),
    );
  }
}

function transformOrderContents(
  sourceOrder: V1Order,
  sourceItems: readonly V1OrderItem[],
  state: TransformState,
): OrderContents {
  const lines: MigratedOrderLine[] = [];
  const garments: MigratedGarment[] = [];
  let subtotalCents = 0;
  sourceItems.forEach((item, lineIndex) => {
    const line = transformLine(item, lineIndex, state.sourceHash);
    subtotalCents = checkedAdd(subtotalCents, line.lineTotalCents, "v1 order subtotal");
    lines.push(line);
    appendGarments(garments, sourceOrder, item, line, state);
  });
  return Object.freeze({
    lines: Object.freeze(lines),
    garments: Object.freeze(garments),
    subtotalCents,
  });
}

function createPayment(
  order: V1Order,
  orderId: string,
  updatedAt: number,
  sourceHash: string,
): MigratedPayment | null {
  if (order.paidCents === 0) return null;
  return Object.freeze({
    id: deterministicId(sourceHash, "payment", order.id),
    orderId,
    amountCents: order.paidCents,
    method: mapPaymentMethod(order.paymentMethod),
    kind: "pay" as const,
    at: updatedAt,
    legacyPaymentMethod: order.paymentMethod,
  });
}

function makeMigratedOrder(
  sourceOrder: V1Order,
  customer: V1Customer,
  contents: OrderContents,
  state: TransformState,
): MigratedOrder {
  const orderId = deterministicId(state.sourceHash, "order", sourceOrder.id);
  assertOrderAmountInvariant(sourceOrder, contents.subtotalCents);
  const createdAt = dateFor(sourceOrder, "createdAt", state.warnings);
  const updatedAt = dateFor(sourceOrder, "updatedAt", state.warnings);
  return Object.freeze({
    id: orderId,
    legacyOrderId: sourceOrder.id,
    ticketNo: sourceOrder.orderNo,
    status: mapOrderStatus(sourceOrder.status),
    customerId: deterministicId(state.sourceHash, "customer", customer.id),
    customerPhone: customer.phone,
    customerName: customer.name,
    note: sourceOrder.note,
    lines: contents.lines,
    garments: contents.garments,
    payment: createPayment(sourceOrder, orderId, updatedAt, state.sourceHash),
    subtotalCents: contents.subtotalCents,
    payableCents: sourceOrder.totalCents,
    paidCents: sourceOrder.paidCents,
    balanceCents: sourceOrder.totalCents - sourceOrder.paidCents,
    createdAt,
    updatedAt,
    legacyPickupCode: sourceOrder.pickupCode,
    legacyExpectedPickupAt: sourceOrder.expectedPickupAt,
    legacyActualPickupAt: sourceOrder.actualPickupAt,
    legacyStaffId: sourceOrder.staffId,
    legacyPickedUpBy: sourceOrder.pickedUpBy,
  });
}

function transformOrder(sourceOrder: V1Order, state: TransformState): MigratedOrder {
  const customer = state.customerByLegacyId.get(sourceOrder.customerId);
  if (customer === undefined)
    throw new V1TransformError(`v1 order ${sourceOrder.id} refers to a missing customer`);
  if (state.seenTicketNumbers.has(sourceOrder.orderNo)) {
    throw new V1TransformError("v1 source contains a duplicate order number");
  }
  const sourceItems = state.itemsByOrderId.get(sourceOrder.id) ?? [];
  if (sourceItems.length === 0)
    throw new V1TransformError(`v1 order ${sourceOrder.id} has no order items`);
  state.seenTicketNumbers.add(sourceOrder.orderNo);
  return makeMigratedOrder(
    sourceOrder,
    customer,
    transformOrderContents(sourceOrder, sourceItems, state),
    state,
  );
}

function transformPhotos(
  sourceHash: string,
  sourcePhotos: readonly V1OrderPhoto[],
  ordersByLegacyId: ReadonlyMap<number, MigratedOrder>,
): readonly MigratedPhoto[] {
  return Object.freeze(
    sourcePhotos.map((photo) => {
      const order = ordersByLegacyId.get(photo.orderId);
      const garment = order?.garments[0];
      if (order === undefined || garment === undefined) {
        throw new V1TransformError(`v1 photo ${photo.id} cannot be attached to a migrated garment`);
      }
      return Object.freeze({
        id: deterministicId(sourceHash, "photo", photo.id),
        legacyPhotoId: photo.id,
        orderId: order.id,
        garmentId: garment.id,
        sourceRelativePath: normalizeLegacyPhotoPath(photo.filePath),
        takenAt: photo.takenAt ?? order.createdAt,
      });
    }),
  );
}

function transformSettings(snapshot: V1Snapshot): readonly MigratedSetting[] {
  return Object.freeze(
    snapshot.settings.map((setting) =>
      Object.freeze({
        id: deterministicId(snapshot.sourceBackupSha256, "setting", setting.key),
        key: setting.key,
        valueJson: toJsonValue(setting.value),
        updatedAt: setting.updatedAt ?? LEGACY_MISSING_DATE_EPOCH,
      }),
    ),
  );
}

/**
 * Pure v1→v2 mapping. It deliberately has no tenant values or PG client:
 * production tenant context and one transaction come from the v2 loader port.
 */
export function transformV1Snapshot(snapshot: V1Snapshot): V2MigrationPlan {
  const warnings: MigrationWarning[] = [];
  const state: TransformState = Object.freeze({
    sourceHash: snapshot.sourceBackupSha256,
    customerByLegacyId: new Map(snapshot.customers.map((customer) => [customer.id, customer])),
    itemsByOrderId: indexItems(snapshot.orderItems),
    warnings,
    seenTicketNumbers: new Set<string>(),
    seenBarcodes: new Set<string>(),
  });
  const orders: MigratedOrder[] = [];
  const ordersByLegacyId = new Map<number, MigratedOrder>();
  for (const sourceOrder of snapshot.orders) {
    const migrated = transformOrder(sourceOrder, state);
    ordersByLegacyId.set(sourceOrder.id, migrated);
    orders.push(migrated);
  }
  return Object.freeze({
    sourceBackupSha256: snapshot.sourceBackupSha256,
    customers: transformCustomers(snapshot),
    orders: Object.freeze(orders),
    photos: transformPhotos(snapshot.sourceBackupSha256, snapshot.orderPhotos, ordersByLegacyId),
    settings: transformSettings(snapshot),
    warnings: Object.freeze(warnings),
  });
}
