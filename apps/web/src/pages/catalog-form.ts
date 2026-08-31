/**
 * Pure input handling for ADR-15 catalog maintenance.
 * Kept out of the component so validation is testable without a DOM.
 */

export type CatalogFormState = Readonly<{
  code: string;
  name: string;
  service_code: string;
  category_code: string;
  price_text: string;
  mnemonic: string;
  is_active: boolean;
  sort_order: number | null;
  expected_version: number;
}>;

export const EMPTY_CATALOG_FORM: CatalogFormState = Object.freeze({
  code: "",
  name: "",
  service_code: "",
  category_code: "",
  price_text: "",
  mnemonic: "",
  is_active: true,
  sort_order: null,
  expected_version: 0,
});

export type CatalogFormRow = Readonly<{
  code: string;
  name: string;
  service_code: string;
  category_code: string;
  unit_price_cents: number;
  mnemonic?: string;
  is_active: boolean;
  sort_order: number;
  version: number;
  updated_at: number;
}>;

export type CatalogBuildResult =
  | Readonly<{ ok: true; body: Readonly<Record<string, unknown>> }>
  | Readonly<{ ok: false; message: string }>;

const CODE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u;
const TAXONOMY = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
/** Integer fen only — the counter never handles floating money. */
const CENTS = /^\d{1,10}$/u;

/** Mirror the contract schema so the operator sees the failure before the round trip. */
export function buildCatalogUpsertBody(form: CatalogFormState): CatalogBuildResult {
  const code = form.code.trim();
  const name = form.name.trim();
  const serviceCode = form.service_code.trim().toLowerCase();
  const categoryCode = form.category_code.trim().toLowerCase();
  const priceText = form.price_text.trim();
  const mnemonic = form.mnemonic.trim();

  if (!CODE.test(code))
    return { ok: false, message: "编码只能用字母数字与 _ - ，且不能以符号开头" };
  if (name.length === 0 || name.length > 64) return { ok: false, message: "名称必须为 1–64 字" };
  if (!TAXONOMY.test(serviceCode))
    return { ok: false, message: "服务代码只能用小写字母数字与 _ -" };
  if (!TAXONOMY.test(categoryCode))
    return { ok: false, message: "品类代码只能用小写字母数字与 _ -" };
  if (!CENTS.test(priceText)) return { ok: false, message: "单价以元为单位，最多两位小数" };
  const unitPriceCents = Number(priceText);
  if (unitPriceCents > POSTGRES_INTEGER_MAX)
    return { ok: false, message: "单价超出系统支持的金额范围" };
  if (mnemonic.length > 16) return { ok: false, message: "助记码最多 16 字符" };

  return {
    ok: true,
    body: Object.freeze({
      code,
      name,
      service_code: serviceCode,
      category_code: categoryCode,
      unit_price_cents: unitPriceCents,
      ...(mnemonic.length > 0 ? { mnemonic } : {}),
      is_active: form.is_active,
      ...(form.sort_order === null ? {} : { sort_order: form.sort_order }),
      expected_version: form.expected_version,
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRow(value: unknown): CatalogFormRow | null {
  if (!isRecord(value)) return null;
  const {
    code,
    name,
    service_code,
    category_code,
    unit_price_cents,
    mnemonic,
    is_active,
    sort_order,
    version,
    updated_at,
  } = value;
  if (
    typeof code !== "string" ||
    typeof name !== "string" ||
    typeof service_code !== "string" ||
    typeof category_code !== "string" ||
    typeof unit_price_cents !== "number" ||
    !Number.isInteger(unit_price_cents) ||
    typeof is_active !== "boolean" ||
    typeof sort_order !== "number" ||
    !Number.isInteger(sort_order) ||
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    typeof updated_at !== "number" ||
    !Number.isInteger(updated_at)
  ) {
    return null;
  }
  return Object.freeze({
    code,
    name,
    service_code,
    category_code,
    unit_price_cents,
    ...(typeof mnemonic === "string" && mnemonic.length > 0 ? { mnemonic } : {}),
    is_active,
    sort_order,
    version,
    updated_at,
  });
}

/**
 * Read catalog rows out of a query response. The query bus wraps handler output
 * in `result`, and a malformed payload must degrade to an empty list rather than
 * reach render as a non-array.
 */
export function readCatalogRows(data: unknown): readonly CatalogFormRow[] {
  const payload = isRecord(data) && "result" in data ? data.result : data;
  if (!isRecord(payload) || !Array.isArray(payload.items)) return Object.freeze([]);
  return Object.freeze(
    payload.items.map(readRow).filter((row): row is CatalogFormRow => row !== null),
  );
}

/** Load an existing row back into the form for repricing or retiring. */
export function catalogFormFromRow(row: CatalogFormRow): CatalogFormState {
  return Object.freeze({
    code: row.code,
    name: row.name,
    service_code: row.service_code,
    category_code: row.category_code,
    price_text: String(row.unit_price_cents),
    mnemonic: row.mnemonic ?? "",
    is_active: row.is_active,
    sort_order: row.sort_order,
    expected_version: row.version,
  });
}

/** Full active snapshot required by catalog.items.reorder. */
export function buildCatalogReorderBody(
  rows: readonly CatalogFormRow[],
): Readonly<{ items: readonly Readonly<{ code: string; expected_version: number }>[] }> {
  return Object.freeze({
    items: Object.freeze(
      rows
        .filter((row) => row.is_active)
        .map((row) => Object.freeze({ code: row.code, expected_version: row.version })),
    ),
  });
}
