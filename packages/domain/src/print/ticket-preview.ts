/**
 * 58mm-style ticket text preview (pure domain).
 * Web UI uses halfwidth ¥ (U+00A5); thermal GBK templates use fullwidth ￥ elsewhere.
 * No I/O.
 */

import { formatFen, validateCents } from "../money.js";

/** Halfwidth yen for web preview (U+00A5). */
export const YUAN_SIGN_UI = "\u00A5";

export type TicketPreviewLine = Readonly<{
  name: string;
  qty: number;
  unit_price_cents: number;
}>;

export type TicketPreviewInput = Readonly<{
  store_name: string;
  store_phone?: string;
  ticket_no: string;
  customer_name?: string | null;
  customer_phone?: string | null;
  receive_date: string;
  lines: readonly TicketPreviewLine[];
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  notice_lines?: readonly string[];
}>;

export type TicketPreview = Readonly<{
  lines: readonly string[];
  total_text: string;
  paid_text: string;
  balance_text: string;
}>;

function assertPositiveQty(qty: number): void {
  if (!Number.isInteger(qty) || qty < 1) {
    throw new Error(`line qty must be positive integer, got ${String(qty)}`);
  }
}

function formatUiMoney(cents: number): string {
  validateCents(cents);
  return formatFen(cents, { symbol: YUAN_SIGN_UI });
}

function lineAmountCents(line: TicketPreviewLine): number {
  validateCents(line.unit_price_cents);
  assertPositiveQty(line.qty);
  return line.unit_price_cents * line.qty;
}

function customerLabel(input: TicketPreviewInput): string {
  const name = input.customer_name?.trim() ?? "";
  const phone = input.customer_phone?.trim() ?? "";
  if (name.length > 0 && phone.length > 0) return `${name} ${phone}`;
  if (name.length > 0) return name;
  if (phone.length > 0) return phone;
  return "—";
}

/**
 * Render 58mm-style ticket text lines from integer-fen order data.
 * Throws on non-integer fen or non-positive qty.
 */
export function renderTicketPreview(input: TicketPreviewInput): TicketPreview {
  validateCents(input.payable_cents);
  validateCents(input.paid_cents);
  validateCents(input.balance_cents);

  const total_text = formatUiMoney(input.payable_cents);
  const paid_text = formatUiMoney(input.paid_cents);
  const balance_text = formatUiMoney(input.balance_cents);

  const lines: string[] = [input.store_name];
  if (input.store_phone !== undefined && input.store_phone.trim().length > 0) {
    lines.push(`电话 ${input.store_phone.trim()}`);
  }
  lines.push("--------------------------------");
  lines.push(`票单号 ${input.ticket_no}`);
  lines.push(`收件 ${input.receive_date}`);
  lines.push(`顾客 ${customerLabel(input)}`);
  lines.push("--------------------------------");
  lines.push("名称            数  金额");

  for (const item of input.lines) {
    const amount = formatUiMoney(lineAmountCents(item));
    lines.push(`${item.name}  x${item.qty}  ${amount}`);
  }

  lines.push("--------------------------------");
  lines.push(`合计 ${total_text}`);
  lines.push(`实收 ${paid_text}`);
  lines.push(`余额 ${balance_text}`);

  for (const notice of input.notice_lines ?? []) {
    lines.push(notice);
  }

  return Object.freeze({
    lines: Object.freeze(lines.slice()),
    total_text,
    paid_text,
    balance_text,
  });
}
