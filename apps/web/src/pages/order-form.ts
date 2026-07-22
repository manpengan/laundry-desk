/**
 * Shared client-side validation / parse helpers for order.receive / order.pickup forms.
 * Integer cents only; mirrors packages/contracts Order*InputSchema without a hard dep.
 */

const PHONE_RE = /^1[3-9]\d{9}$/u;
const CODE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type ReceiveLineDraft = Readonly<{
  key: string;
  service_code: string;
  category_code: string;
  unit_price_cents: string;
  qty: string;
}>;

export type ReceiveGarmentResult = Readonly<{
  garment_id: string;
  barcode: string;
  status: string;
  line_index: number;
  seq: number;
}>;

export type ReceiveOrderResult = Readonly<{
  order_id: string;
  ticket_no: string;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  garment_count: number;
  garments: readonly ReceiveGarmentResult[];
}>;

export type PickupOrderResult = Readonly<{
  order_id: string;
  ticket_no: string;
  status: string;
  paid_cents: number;
  balance_cents: number;
  picked_garment_ids: readonly string[];
}>;

export function parseNonNegCents(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

export function parsePositiveInt(text: string, max: number): number | null {
  const n = parseNonNegCents(text);
  if (n === null || n < 1 || n > max) return null;
  return n;
}

export function isValidPhone(text: string): boolean {
  return PHONE_RE.test(text.trim());
}

export function isValidCode(text: string): boolean {
  return CODE_RE.test(text.trim());
}

export function isValidUuid(text: string): boolean {
  return UUID_RE.test(text.trim());
}

/** Bus HTTP envelope is `{ execution, result }`; tolerate bare result for mocks. */
export function unwrapCommandResult<T>(data: unknown): T | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const rec = data as Record<string, unknown>;
  if ("result" in rec) {
    return (rec.result ?? null) as T | null;
  }
  return data as T;
}

export function newLineDraft(index: number): ReceiveLineDraft {
  return Object.freeze({
    key: `line-${index}-${Date.now()}`,
    service_code: "wash",
    category_code: "shirt",
    unit_price_cents: "1500",
    qty: "1",
  });
}

export type BuiltReceiveLine = Readonly<{
  service_code: string;
  category_code: string;
  unit_price_cents: number;
  qty: number;
}>;

export type BuildReceiveBodyResult =
  | Readonly<{ ok: true; body: Readonly<Record<string, unknown>> }>
  | Readonly<{ ok: false; message: string }>;

export function buildReceiveBody(input: {
  customer_phone: string;
  customer_name: string;
  paid_cents: string;
  note: string;
  lines: readonly ReceiveLineDraft[];
}): BuildReceiveBodyResult {
  if (input.lines.length < 1) {
    return Object.freeze({ ok: false as const, message: "至少添加一行衣物" });
  }
  const lines: BuiltReceiveLine[] = [];
  for (let i = 0; i < input.lines.length; i += 1) {
    const line = input.lines[i]!;
    const service = line.service_code.trim();
    const category = line.category_code.trim();
    if (!isValidCode(service) || !isValidCode(category)) {
      return Object.freeze({
        ok: false as const,
        message: `第 ${i + 1} 行服务/品类代码无效`,
      });
    }
    const unit = parseNonNegCents(line.unit_price_cents);
    const qty = parsePositiveInt(line.qty, 50);
    if (unit === null) {
      return Object.freeze({
        ok: false as const,
        message: `第 ${i + 1} 行单价须为整数分`,
      });
    }
    if (qty === null) {
      return Object.freeze({
        ok: false as const,
        message: `第 ${i + 1} 行数量须为 1–50 整数`,
      });
    }
    lines.push(
      Object.freeze({
        service_code: service,
        category_code: category,
        unit_price_cents: unit,
        qty,
      }),
    );
  }

  const paid = parseNonNegCents(input.paid_cents);
  if (paid === null) {
    return Object.freeze({ ok: false as const, message: "已付金额须为整数分（如 0）" });
  }

  const body: Record<string, unknown> = {
    lines,
    paid_cents: paid,
  };

  const phone = input.customer_phone.trim();
  if (phone.length > 0) {
    if (!isValidPhone(phone)) {
      return Object.freeze({
        ok: false as const,
        message: "手机号格式无效（11 位 1[3-9]…，种子 13800000xxx）",
      });
    }
    body.customer_phone = phone;
  }

  const name = input.customer_name.trim();
  if (name.length > 0) {
    if (name.length > 64) {
      return Object.freeze({ ok: false as const, message: "客户姓名过长" });
    }
    body.customer_name = name;
  }

  const note = input.note.trim();
  if (note.length > 0) {
    if (note.length > 256) {
      return Object.freeze({ ok: false as const, message: "备注过长" });
    }
    body.note = note;
  }

  return Object.freeze({ ok: true as const, body: Object.freeze(body) });
}

export type BuildPickupBodyResult =
  | Readonly<{ ok: true; body: Readonly<Record<string, unknown>> }>
  | Readonly<{ ok: false; message: string }>;

export function buildPickupBody(input: {
  order_id: string;
  collect_cents: string;
  garment_ids_text: string;
}): BuildPickupBodyResult {
  const orderId = input.order_id.trim();
  if (!isValidUuid(orderId)) {
    return Object.freeze({ ok: false as const, message: "订单 ID 须为 UUID" });
  }
  const collect = parseNonNegCents(input.collect_cents);
  if (collect === null) {
    return Object.freeze({ ok: false as const, message: "收款金额须为整数分" });
  }

  const raw = input.garment_ids_text.trim();
  let garmentIds: string[] = [];
  if (raw.length > 0) {
    garmentIds = raw
      .split(/[\s,，]+/u)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (garmentIds.length > 200) {
      return Object.freeze({ ok: false as const, message: "件 ID 最多 200 个" });
    }
    for (const id of garmentIds) {
      if (!isValidUuid(id)) {
        return Object.freeze({
          ok: false as const,
          message: `无效 garment_id：${id.slice(0, 12)}…`,
        });
      }
    }
  }

  return Object.freeze({
    ok: true as const,
    body: Object.freeze({
      order_id: orderId,
      collect_cents: collect,
      garment_ids: Object.freeze(garmentIds),
    }),
  });
}
