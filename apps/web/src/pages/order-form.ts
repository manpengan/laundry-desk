/**
 * Shared client-side validation / parse helpers for order.receive / order.pickup forms.
 * Integer cents only; mirrors packages/contracts Order*InputSchema without a hard dep.
 */

import type { OrderGetGarment } from "./order-read-model.js";
import type { ReceiveGarmentDraft, ReceiveLineDraft } from "./receive-garment-form.js";

export { buildPickupBody, type BuildPickupBodyResult } from "./pickup-form.js";
export {
  parseOrderGetResult,
  type OrderGetGarment,
  type OrderGetLine,
  type OrderGetPieceDetail,
  type OrderGetResult,
  type PricingAddonSnapshotView,
} from "./order-read-model.js";
export {
  newGarmentDraft,
  newLineDraft,
  resizeGarmentDrafts,
  type ReceiveGarmentDraft,
  type ReceiveLineDraft,
} from "./receive-garment-form.js";
export {
  parseHoldDraftId,
  parseReceiveOrderResult,
  type ReceiveGarmentResult,
  type ReceiveOrderResult,
} from "./receive-result-model.js";

const PHONE_RE = /^1[3-9]\d{9}$/u;
const CODE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type PaymentMethod = "cash" | "wechat" | "alipay" | "other";

export type PickupOrderResult = Readonly<{
  order_id: string;
  ticket_no: string;
  status: string;
  paid_cents: number;
  balance_cents: number;
  picked_garment_ids: readonly string[];
}>;

/** Counter pickup supports direct received/ready pickup and verified racked pickup. */
export function isPickableGarmentStatus(status: string): boolean {
  return status === "received" || status === "ready" || status === "racked";
}

export function listPickableGarments(
  garments: readonly OrderGetGarment[],
): readonly OrderGetGarment[] {
  return Object.freeze(garments.filter((g) => isPickableGarmentStatus(g.status)));
}

export function pickableGarmentIds(garments: readonly OrderGetGarment[]): readonly string[] {
  return Object.freeze(listPickableGarments(garments).map((g) => g.garment_id));
}

export function toggleGarmentSelection(
  selected: ReadonlySet<string>,
  garmentId: string,
): ReadonlySet<string> {
  const next = new Set(selected);
  if (next.has(garmentId)) next.delete(garmentId);
  else next.add(garmentId);
  return next;
}

export function selectAllPickableIds(garments: readonly OrderGetGarment[]): ReadonlySet<string> {
  return new Set(pickableGarmentIds(garments));
}

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

export type BuiltReceiveLine = Readonly<{
  service_code: string;
  category_code: string;
  unit_price_cents: number;
  qty: number;
}>;

type PreparedReceiveLine = BuiltReceiveLine &
  Readonly<{ garments: readonly Readonly<Record<string, unknown>>[] }>;

export type BuildReceiveBodyResult =
  | Readonly<{
      ok: true;
      body: Readonly<Record<string, unknown>>;
      previewLines: readonly BuiltReceiveLine[];
    }>
  | Readonly<{ ok: false; message: string }>;

function parseDetailTags(text: string): readonly string[] | null {
  if (text.trim().length === 0) return Object.freeze([]);
  const items = text
    .split(/[,，]/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.length > 12 || items.some((item) => item.length > 32)) return null;
  return Object.freeze(items);
}

function buildGarmentDetail(
  garment: ReceiveGarmentDraft,
  lineIndex: number,
  garmentIndex: number,
): Readonly<Record<string, unknown>> | string {
  const color = garment.color.trim();
  const brand = garment.brand.trim();
  const note = garment.note.trim();
  const defects = parseDetailTags(garment.defects_text);
  const accessories = parseDetailTags(garment.accessories_text);
  const prefix = `第 ${lineIndex + 1} 行第 ${garmentIndex + 1} 件`;
  if (color.length > 32 || brand.length > 32) return `${prefix}颜色或品牌过长`;
  if (note.length > 256) return `${prefix}备注过长`;
  if (defects === null || accessories === null)
    return `${prefix}瑕疵或附件最多 12 项且每项不超过 32 字`;
  const addonCodes = garment.addon_codes;
  if (
    addonCodes.length > 8 ||
    addonCodes.some((code) => !isValidCode(code)) ||
    new Set(addonCodes).size !== addonCodes.length
  ) {
    return `${prefix}附加项无效或重复`;
  }
  return Object.freeze({
    ...(color.length === 0 ? {} : { color }),
    ...(brand.length === 0 ? {} : { brand }),
    ...(defects.length === 0 ? {} : { defects }),
    ...(accessories.length === 0 ? {} : { accessories }),
    ...(note.length === 0 ? {} : { note }),
    ...(addonCodes.length === 0 ? {} : { addon_codes: Object.freeze([...addonCodes]) }),
  });
}

export function buildReceiveBody(input: {
  customer_phone: string;
  customer_name: string;
  initial_payment_cents: string;
  initial_payment_method: PaymentMethod;
  discount_cents: string;
  urgent: boolean;
  freight: boolean;
  note: string;
  lines: readonly ReceiveLineDraft[];
  draft_id?: string;
}): BuildReceiveBodyResult {
  if (input.lines.length < 1 || input.lines.length > 40) {
    return Object.freeze({ ok: false as const, message: "衣物须为 1–40 行" });
  }
  const lines: PreparedReceiveLine[] = [];
  let originalCents = 0;
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
    const qty = parsePositiveInt(line.qty, 50);
    if (
      line.unit_price_cents === null ||
      !Number.isSafeInteger(line.unit_price_cents) ||
      line.unit_price_cents < 0 ||
      line.unit_price_cents > 2_147_483_647
    ) {
      return Object.freeze({
        ok: false as const,
        message: `第 ${i + 1} 行请从价目表选择服务`,
      });
    }
    if (qty === null) {
      return Object.freeze({
        ok: false as const,
        message: `第 ${i + 1} 行数量须为 1–50 整数`,
      });
    }
    if (line.garments.length !== qty) {
      return Object.freeze({
        ok: false as const,
        message: `第 ${i + 1} 行逐件信息与数量不一致`,
      });
    }
    const nextOriginal = originalCents + line.unit_price_cents * qty;
    if (!Number.isSafeInteger(nextOriginal)) {
      return Object.freeze({ ok: false as const, message: "价目金额超出安全范围" });
    }
    originalCents = nextOriginal;
    const garments: Readonly<Record<string, unknown>>[] = [];
    for (let garmentIndex = 0; garmentIndex < line.garments.length; garmentIndex += 1) {
      const detail = buildGarmentDetail(line.garments[garmentIndex]!, i, garmentIndex);
      if (typeof detail === "string") {
        return Object.freeze({ ok: false as const, message: detail });
      }
      garments.push(detail);
    }
    lines.push(
      Object.freeze({
        service_code: service,
        category_code: category,
        unit_price_cents: line.unit_price_cents,
        qty,
        garments: Object.freeze(garments),
      }),
    );
  }

  const discountCents = parseNonNegCents(input.discount_cents);
  if (discountCents === null) {
    return Object.freeze({ ok: false as const, message: "折扣须为非负整数分" });
  }
  if (discountCents > originalCents) {
    return Object.freeze({ ok: false as const, message: "折扣不能超过原价" });
  }
  const initialPayment = parseNonNegCents(input.initial_payment_cents);
  if (initialPayment === null) {
    return Object.freeze({ ok: false as const, message: "首笔收款须为非负整数分" });
  }

  if (input.draft_id !== undefined) {
    if (!isValidUuid(input.draft_id)) {
      return Object.freeze({ ok: false as const, message: "挂单标识无效，请重新暂存" });
    }
  }

  const phone = input.customer_phone.trim();
  if (phone.length > 0) {
    if (!isValidPhone(phone)) {
      return Object.freeze({
        ok: false as const,
        message: "手机号格式无效（11 位 1[3-9]…，种子 13800000xxx）",
      });
    }
  }

  const name = input.customer_name.trim();
  if (name.length > 0) {
    if (name.length > 64) {
      return Object.freeze({ ok: false as const, message: "客户姓名过长" });
    }
  }

  const note = input.note.trim();
  if (note.length > 0) {
    if (note.length > 256) {
      return Object.freeze({ ok: false as const, message: "备注过长" });
    }
  }

  const body = Object.freeze({
    lines: Object.freeze(
      lines.map(({ service_code, category_code, qty, garments }) =>
        Object.freeze({ service_code, category_code, qty, garments }),
      ),
    ),
    discount_cents: discountCents,
    urgent: input.urgent,
    freight: input.freight,
    ...(initialPayment > 0
      ? {
          initial_payment: Object.freeze({
            amount_cents: initialPayment,
            method: input.initial_payment_method,
          }),
        }
      : {}),
    ...(input.draft_id === undefined ? {} : { draft_id: input.draft_id }),
    ...(phone.length === 0 ? {} : { customer_phone: phone }),
    ...(name.length === 0 ? {} : { customer_name: name }),
    ...(note.length === 0 ? {} : { note }),
  });

  return Object.freeze({
    ok: true as const,
    body,
    previewLines: Object.freeze(
      lines.map(({ service_code, category_code, unit_price_cents, qty }) =>
        Object.freeze({ service_code, category_code, unit_price_cents, qty }),
      ),
    ),
  });
}
