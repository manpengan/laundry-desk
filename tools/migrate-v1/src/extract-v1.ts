import { createHash } from "node:crypto";
import { copyFile, chmod, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import Database from "better-sqlite3";
import { z } from "zod";

import type {
  V1Customer,
  V1Order,
  V1OrderItem,
  V1OrderPhoto,
  V1Setting,
  V1Snapshot,
} from "./types.js";

const SQLITE_FILE_MODE = 0o600;
const REQUIRED_TABLES = Object.freeze([
  "customers",
  "orders",
  "order_items",
  "order_photos",
  "settings",
] as const);

const safeInteger = z.number().int().refine(Number.isSafeInteger, "must be a safe integer");
const optionalEpoch = safeInteger.nonnegative().nullable();

const customerRowSchema = z
  .object({
    id: safeInteger.positive(),
    name: z.string().min(1),
    phone: z.string().min(1),
    vip_level: safeInteger.nonnegative(),
    total_orders: safeInteger.nonnegative(),
    total_spent: safeInteger.nonnegative(),
    created_at: optionalEpoch,
    updated_at: optionalEpoch,
  })
  .strict();

const orderRowSchema = z
  .object({
    id: safeInteger.positive(),
    order_no: z.string().min(1),
    pickup_code: z.string().min(1),
    customer_id: safeInteger.positive(),
    status: z.enum(["pending", "ready", "picked_up", "cancelled"]),
    total_amount: safeInteger.nonnegative(),
    paid_amount: safeInteger.nonnegative(),
    payment_method: z.enum(["cash", "wechat", "alipay", "card", "unpaid"]),
    receive_date: optionalEpoch,
    expected_pickup_date: optionalEpoch,
    actual_pickup_at: optionalEpoch,
    staff_id: safeInteger.positive().nullable(),
    picked_up_by: safeInteger.positive().nullable(),
    notes: z.string().nullable(),
    created_at: optionalEpoch,
    updated_at: optionalEpoch,
  })
  .strict();

const orderItemRowSchema = z
  .object({
    id: safeInteger.positive(),
    order_id: safeInteger.positive(),
    item_type: z.string().min(1),
    service_type: z.enum(["wash", "dry_clean", "iron"]),
    quantity: safeInteger.positive(),
    unit_price: safeInteger.nonnegative(),
    subtotal: safeInteger.nonnegative(),
    item_notes: z.string().nullable(),
  })
  .strict();

const orderPhotoRowSchema = z
  .object({
    id: safeInteger.positive(),
    order_id: safeInteger.positive(),
    file_path: z.string().min(1),
    taken_at: optionalEpoch,
  })
  .strict();

const settingRowSchema = z
  .object({
    key: z.string().min(1),
    value: z.string(),
    updated_at: optionalEpoch,
  })
  .strict();

type SqliteRowSchema<T> = z.ZodType<T>;

export class V1ExtractionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "V1ExtractionError";
  }
}

async function sha256File(path: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => {
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function copyReadOnlySnapshot(sourcePath: string): Promise<{
  readonly path: string;
  readonly cleanup: () => Promise<void>;
  readonly sha256: string;
}> {
  const source = await realpath(sourcePath);
  const sourceStat = await stat(source);
  if (!sourceStat.isFile()) {
    throw new V1ExtractionError("v1 source must be a regular SQLite backup file");
  }

  const beforeHash = await sha256File(source);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "laundry-v1-migration-"));
  const snapshotPath = join(temporaryDirectory, basename(source));

  try {
    await copyFile(source, snapshotPath);
    await chmod(snapshotPath, SQLITE_FILE_MODE);
    const [copiedHash, afterHash] = await Promise.all([
      sha256File(snapshotPath),
      sha256File(source),
    ]);
    if (beforeHash !== afterHash || beforeHash !== copiedHash) {
      throw new V1ExtractionError("v1 source changed while its read-only snapshot was created");
    }
    return Object.freeze({
      path: snapshotPath,
      cleanup: async () => rm(temporaryDirectory, { force: true, recursive: true }),
      sha256: copiedHash,
    });
  } catch (error) {
    await rm(temporaryDirectory, { force: true, recursive: true });
    throw error;
  }
}

function assertReadOnlySelect(sql: string): void {
  if (!/^\s*SELECT\s/iu.test(sql) || /;\s*\S/u.test(sql)) {
    throw new V1ExtractionError("v1 extractor only permits one SELECT statement");
  }
}

function readRows<T>(
  database: Database.Database,
  sql: string,
  schema: SqliteRowSchema<T>,
): readonly T[] {
  assertReadOnlySelect(sql);
  const rows = database.prepare(sql).all() as unknown[];
  return Object.freeze(rows.map((row) => schema.parse(row)));
}

function assertSourceTables(database: Database.Database): void {
  const tableSchema = z.object({ name: z.string() }).strict();
  const rows = readRows(
    database,
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    tableSchema,
  );
  const names = new Set(rows.map((row) => row.name));
  for (const tableName of REQUIRED_TABLES) {
    if (!names.has(tableName)) {
      throw new V1ExtractionError(`v1 source is missing required table: ${tableName}`);
    }
  }
}

function mapCustomer(row: z.infer<typeof customerRowSchema>): V1Customer {
  return Object.freeze({
    id: row.id,
    name: row.name,
    phone: row.phone,
    vipLevel: row.vip_level,
    totalOrders: row.total_orders,
    totalSpentCents: row.total_spent,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapOrder(row: z.infer<typeof orderRowSchema>): V1Order {
  return Object.freeze({
    id: row.id,
    orderNo: row.order_no,
    pickupCode: row.pickup_code,
    customerId: row.customer_id,
    status: row.status,
    totalCents: row.total_amount,
    paidCents: row.paid_amount,
    paymentMethod: row.payment_method,
    receiveAt: row.receive_date,
    expectedPickupAt: row.expected_pickup_date,
    actualPickupAt: row.actual_pickup_at,
    staffId: row.staff_id,
    pickedUpBy: row.picked_up_by,
    note: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapOrderItem(row: z.infer<typeof orderItemRowSchema>): V1OrderItem {
  return Object.freeze({
    id: row.id,
    orderId: row.order_id,
    itemType: row.item_type,
    serviceType: row.service_type,
    quantity: row.quantity,
    unitPriceCents: row.unit_price,
    subtotalCents: row.subtotal,
    itemNotes: row.item_notes,
  });
}

function mapOrderPhoto(row: z.infer<typeof orderPhotoRowSchema>): V1OrderPhoto {
  return Object.freeze({
    id: row.id,
    orderId: row.order_id,
    filePath: row.file_path,
    takenAt: row.taken_at,
  });
}

function mapSetting(row: z.infer<typeof settingRowSchema>): V1Setting {
  return Object.freeze({ key: row.key, value: row.value, updatedAt: row.updated_at });
}

type ExtractedRows = Readonly<{
  customers: readonly V1Customer[];
  orders: readonly V1Order[];
  orderItems: readonly V1OrderItem[];
  orderPhotos: readonly V1OrderPhoto[];
  settings: readonly V1Setting[];
}>;

function readSnapshotRows(database: Database.Database): ExtractedRows {
  assertSourceTables(database);
  return Object.freeze({
    customers: readRows(
      database,
      "SELECT id, name, phone, vip_level, total_orders, total_spent, created_at, updated_at FROM customers ORDER BY id",
      customerRowSchema,
    ).map(mapCustomer),
    orders: readRows(
      database,
      "SELECT id, order_no, pickup_code, customer_id, status, total_amount, paid_amount, payment_method, receive_date, expected_pickup_date, actual_pickup_at, staff_id, picked_up_by, notes, created_at, updated_at FROM orders ORDER BY id",
      orderRowSchema,
    ).map(mapOrder),
    orderItems: readRows(
      database,
      "SELECT id, order_id, item_type, service_type, quantity, unit_price, subtotal, item_notes FROM order_items ORDER BY id",
      orderItemRowSchema,
    ).map(mapOrderItem),
    orderPhotos: readRows(
      database,
      "SELECT id, order_id, file_path, taken_at FROM order_photos ORDER BY id",
      orderPhotoRowSchema,
    ).map(mapOrderPhoto),
    settings: readRows(
      database,
      "SELECT key, value, updated_at FROM settings ORDER BY key",
      settingRowSchema,
    ).map(mapSetting),
  });
}

/**
 * Extract the frozen v1 schema through a private copy. The source is never
 * opened for writing and every executable statement is a single SELECT.
 */
export async function extractV1Snapshot(sourcePath: string): Promise<V1Snapshot> {
  let snapshot:
    | Readonly<{
        path: string;
        cleanup: () => Promise<void>;
        sha256: string;
      }>
    | undefined;
  let database: Database.Database | undefined;
  try {
    snapshot = await copyReadOnlySnapshot(sourcePath);
    database = new Database(snapshot.path, { fileMustExist: true, readonly: true });
    database.pragma("query_only = ON");
    database.pragma("trusted_schema = OFF");
    return Object.freeze({ sourceBackupSha256: snapshot.sha256, ...readSnapshotRows(database) });
  } catch (error) {
    if (error instanceof V1ExtractionError || error instanceof z.ZodError) throw error;
    throw new V1ExtractionError("unable to read the v1 SQLite source safely");
  } finally {
    database?.close();
    await snapshot?.cleanup();
  }
}
