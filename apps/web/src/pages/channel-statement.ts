import { ChannelReconcileInputSchema, type ChannelReconcileInput } from "@laundry/contracts";

type Channel = "wechat" | "alipay";
type Row = ChannelReconcileInput["rows"][number];
export type StatementSource = "canonical" | "wechat" | "alipay";
export type ParsedStatement = Readonly<{
  input: ChannelReconcileInput;
  source: StatementSource;
  /** Rows this system did not create (other terminals, revoked codes, transfers). */
  skipped: number;
}>;

const CANONICAL = "商户订单号,渠道订单号,金额分,类型,商户退款号";
/** Merchant order and refund numbers this system issues: a UUID without hyphens. */
const OURS = /^[0-9a-f]{32}$/u;
const YUAN = /^-?(\d{1,7})(?:\.(\d{1,2}))?$/u;

/** Official bills arrive as UTF-8 (WeChat) or GBK (Alipay); try the strict decoder first. */
export function decodeStatement(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("gb18030").decode(bytes);
  }
}

/** Minimal RFC 4180 split; Alipay pads cells with tabs to stop spreadsheets reformatting them. */
function csvCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "",
    quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted && char === '"' && line[index + 1] === '"') {
      cell += '"';
      index++;
    } else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

/** WeChat prefixes every cell with a backtick, so only ",`" separates cells. */
const wechatCells = (line: string) =>
  line.split(/,(?=`)/u).map((cell) => cell.trim().replace(/^`/u, "").trim());

function yuanToCents(text: string, line: number): number {
  const match = YUAN.exec(text);
  if (match === null) throw new Error(`第 ${line} 行金额格式不正确`);
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

type Columns = Readonly<{ at: (cells: readonly string[], name: string) => string }>;
function columns(header: readonly string[]): Columns {
  return {
    at(cells, name) {
      const index = header.findIndex(
        (cell) => cell === name || cell.startsWith(`${name}（`) || cell.startsWith(`${name}(`),
      );
      return index < 0 ? "" : (cells[index] ?? "");
    },
  };
}

type Extract = (cells: readonly string[], line: number) => Row | null;

const wechatRow =
  (col: Columns): Extract =>
  (cells, line) => {
    const status = col.at(cells, "交易状态");
    if (status !== "SUCCESS" && status !== "REFUND") return null;
    const refund = status === "REFUND";
    const amount = refund
      ? col.at(cells, "申请退款金额") || col.at(cells, "退款金额")
      : col.at(cells, "订单金额") || col.at(cells, "应结订单金额");
    return {
      merchant_order: col.at(cells, "商户订单号"),
      provider_order: col.at(cells, "微信订单号"),
      amount_cents: yuanToCents(amount, line),
      kind: refund ? "refund" : "payment",
      merchant_refund: refund ? col.at(cells, "商户退款单号") : null,
    };
  };

const alipayRow =
  (col: Columns): Extract =>
  (cells, line) => {
    const type = col.at(cells, "业务类型");
    if (type !== "交易" && type !== "退款") return null;
    const refund = type === "退款";
    return {
      merchant_order: col.at(cells, "商户订单号"),
      provider_order: col.at(cells, "支付宝交易号"),
      // Refund rows carry a negative order amount.
      amount_cents: Math.abs(yuanToCents(col.at(cells, "订单金额"), line)),
      kind: refund ? "refund" : "payment",
      merchant_refund: refund ? col.at(cells, "退款批次号/请求号") : null,
    };
  };

function canonicalRow(cells: readonly string[], line: number): Row {
  if (cells.length !== 5 || !/^[1-9]\d{0,6}$/u.test(cells[2] ?? ""))
    throw new Error(`第 ${line} 行须包含五列，金额使用正整数分`);
  const kind = cells[3] === "收款" ? "payment" : cells[3] === "退款" ? "refund" : null;
  if (kind === null) throw new Error(`第 ${line} 行类型须为“收款”或“退款”`);
  return {
    merchant_order: cells[0] ?? "",
    provider_order: cells[1] ?? "",
    amount_cents: Number(cells[2]),
    kind,
    merchant_refund: cells[4] || null,
  };
}

function detect(channel: Channel, header: string) {
  if (header === CANONICAL) return { source: "canonical" as const, split: csvCells };
  // Header names carry no backtick; only WeChat data cells do.
  const names = csvCells(header);
  if (names.includes("微信订单号")) {
    if (channel !== "wechat") throw new Error("这是微信支付账单，请把渠道选为微信");
    return { source: "wechat" as const, split: wechatCells, extract: wechatRow(columns(names)) };
  }
  if (names.includes("支付宝交易号")) {
    if (channel !== "alipay") throw new Error("这是支付宝账单，请把渠道选为支付宝");
    return { source: "alipay" as const, split: csvCells, extract: alipayRow(columns(names)) };
  }
  throw new Error("无法识别账单：请选择微信支付交易账单、支付宝业务明细，或页面说明的规范 CSV");
}

function assertDate(businessDate: string): void {
  const stamp = Date.parse(`${businessDate}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(businessDate) ||
    !Number.isFinite(stamp) ||
    new Date(stamp).toISOString().slice(0, 10) !== businessDate
  )
    throw new Error("账单日期不存在");
}

/**
 * ADR-85 r1 (P1-4): reads the bill the merchant downloads — WeChat Pay trade bill,
 * Alipay business detail, or the canonical five-column CSV — into exact-cent rows.
 */
export function readChannelStatement(
  channel: Channel,
  businessDate: string,
  text: string,
): ParsedStatement {
  if (text.length > 2_000_000) throw new Error("账单超过 2 MB，请按日导出");
  assertDate(businessDate);
  const lines = text.replace(/^﻿/u, "").split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() !== "" && !line.startsWith("#"));
  if (start < 0) throw new Error("账单是空的");
  const format = detect(channel, lines[start]!.trim());
  const rows: Row[] = [];
  let skipped = 0;
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (line === "") continue;
    // Both official bills end with summary lines (WeChat 总交易单数, Alipay #…).
    if (line.startsWith("#") || line.startsWith("总交易单数")) break;
    const cells = format.split(line);
    if (format.source === "canonical") {
      rows.push(canonicalRow(cells, index + 1));
      continue;
    }
    const row = format.extract(cells, index + 1);
    const ours =
      row !== null &&
      OURS.test(row.merchant_order) &&
      (row.merchant_refund === null || OURS.test(row.merchant_refund));
    if (ours) rows.push(row);
    else skipped++;
  }
  if (rows.length === 0)
    throw new Error(skipped > 0 ? "账单里没有本系统发起的收款或退款" : "账单里没有流水");
  if (rows.length > 10000) throw new Error("每次最多核对 10000 笔，请按日导出");
  const parsed = ChannelReconcileInputSchema.safeParse({
    channel,
    business_date: businessDate,
    rows,
  });
  if (!parsed.success) throw new Error("请检查订单号、退款号、类型及金额；每笔最多 50000 元");
  return { input: parsed.data, source: format.source, skipped };
}
