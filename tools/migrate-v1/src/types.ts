/** Frozen, read-only v1 SQLite records. All monetary values are integer cents. */
export type V1Customer = Readonly<{
  id: number;
  name: string;
  phone: string;
  vipLevel: number;
  totalOrders: number;
  totalSpentCents: number;
  createdAt: number | null;
  updatedAt: number | null;
}>;

export type V1Order = Readonly<{
  id: number;
  orderNo: string;
  pickupCode: string;
  customerId: number;
  status: "pending" | "ready" | "picked_up" | "cancelled";
  totalCents: number;
  paidCents: number;
  paymentMethod: "cash" | "wechat" | "alipay" | "card" | "unpaid";
  receiveAt: number | null;
  expectedPickupAt: number | null;
  actualPickupAt: number | null;
  staffId: number | null;
  pickedUpBy: number | null;
  note: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}>;

export type V1OrderItem = Readonly<{
  id: number;
  orderId: number;
  itemType: string;
  serviceType: "wash" | "dry_clean" | "iron";
  quantity: number;
  unitPriceCents: number;
  subtotalCents: number;
  itemNotes: string | null;
}>;

export type V1OrderPhoto = Readonly<{
  id: number;
  orderId: number;
  filePath: string;
  takenAt: number | null;
}>;

export type V1Setting = Readonly<{
  key: string;
  value: string;
  updatedAt: number | null;
}>;

export type V1Snapshot = Readonly<{
  sourceBackupSha256: string;
  customers: readonly V1Customer[];
  orders: readonly V1Order[];
  orderItems: readonly V1OrderItem[];
  orderPhotos: readonly V1OrderPhoto[];
  settings: readonly V1Setting[];
}>;

export type MigrationGarmentStatus = "received" | "ready" | "picked_up";
export type MigrationOrderStatus = "open" | "closed" | "cancelled";
export type MigrationPaymentMethod = "cash" | "wechat" | "alipay" | "other";

export type MigratedCustomer = Readonly<{
  id: string;
  legacyCustomerId: number;
  phone: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  legacyVipLevel: number;
  legacyTotalOrders: number;
  legacyTotalSpentCents: number;
}>;

export type MigratedOrderLine = Readonly<{
  id: string;
  legacyOrderItemId: number;
  lineIndex: number;
  serviceCode: string;
  categoryCode: string;
  unitPriceCents: number;
  qty: number;
  lineTotalCents: number;
  legacyItemType: string;
  legacyItemNotes: string | null;
}>;

export type MigratedGarment = Readonly<{
  id: string;
  orderId: string;
  orderLineId: string;
  lineIndex: number;
  seq: number;
  barcode: string;
  serviceCode: string;
  categoryCode: string;
  unitPriceCents: number;
  status: MigrationGarmentStatus;
}>;

export type MigratedPayment = Readonly<{
  id: string;
  orderId: string;
  amountCents: number;
  method: MigrationPaymentMethod;
  kind: "pay";
  at: number;
  legacyPaymentMethod: V1Order["paymentMethod"];
}>;

export type MigratedOrder = Readonly<{
  id: string;
  legacyOrderId: number;
  ticketNo: string;
  status: MigrationOrderStatus;
  customerId: string;
  customerPhone: string;
  customerName: string;
  note: string | null;
  lines: readonly MigratedOrderLine[];
  garments: readonly MigratedGarment[];
  payment: MigratedPayment | null;
  subtotalCents: number;
  payableCents: number;
  paidCents: number;
  balanceCents: number;
  createdAt: number;
  updatedAt: number;
  legacyPickupCode: string;
  legacyExpectedPickupAt: number | null;
  legacyActualPickupAt: number | null;
  legacyStaffId: number | null;
  legacyPickedUpBy: number | null;
}>;

/**
 * v1 stores photos by order; v2 requires a garment. The deterministic first
 * garment association is explicit so the production loader can present it for
 * operator review before copying the asset to object storage.
 */
export type MigratedPhoto = Readonly<{
  id: string;
  legacyPhotoId: number;
  orderId: string;
  garmentId: string;
  sourceRelativePath: string;
  takenAt: number;
}>;

export type MigratedSetting = Readonly<{
  id: string;
  key: string;
  valueJson: string;
  updatedAt: number;
}>;

export type MigrationWarning = Readonly<{
  code: "MISSING_DATE_DEFAULTED";
  legacyOrderId: number;
  field: "createdAt" | "updatedAt";
}>;

export type V2MigrationPlan = Readonly<{
  sourceBackupSha256: string;
  customers: readonly MigratedCustomer[];
  orders: readonly MigratedOrder[];
  photos: readonly MigratedPhoto[];
  settings: readonly MigratedSetting[];
  warnings: readonly MigrationWarning[];
}>;

export type ReconciliationTotals = Readonly<{
  orders: number;
  garments: number;
  customers: number;
  receivableCents: number;
  paidCents: number;
  debtCents: number;
  photos: number;
}>;

export type ReconciliationReport = Readonly<{
  sourceBackupSha256: string;
  source: ReconciliationTotals;
  target: ReconciliationTotals;
  differences: ReconciliationTotals;
  isZeroDifference: boolean;
}>;
