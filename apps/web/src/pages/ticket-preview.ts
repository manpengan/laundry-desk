/**
 * Map order.receive form drafts + success result → domain ticket preview input.
 * Domain owns pure render; this file stays free of I/O.
 */

import {
  renderTicketPreview,
  type TicketPreview,
  type TicketPreviewInput,
  type TicketPreviewLine,
} from "@laundry/domain";
import type { BuiltReceiveLine, ReceiveOrderResult } from "./order-form.js";

/** Parse built receive lines from a successful buildReceiveBody payload. */
export function readBuiltLines(
  body: Readonly<Record<string, unknown>>,
): readonly BuiltReceiveLine[] {
  const raw = body.lines;
  if (!Array.isArray(raw)) return Object.freeze([]);
  const out: BuiltReceiveLine[] = [];
  for (const row of raw) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.service_code !== "string" || typeof r.category_code !== "string") continue;
    if (typeof r.unit_price_cents !== "number" || !Number.isInteger(r.unit_price_cents)) continue;
    if (typeof r.qty !== "number" || !Number.isInteger(r.qty) || r.qty < 1) continue;
    out.push(
      Object.freeze({
        service_code: r.service_code,
        category_code: r.category_code,
        unit_price_cents: r.unit_price_cents,
        qty: r.qty,
      }),
    );
  }
  return Object.freeze(out);
}

export type BuildTicketPreviewOpts = Readonly<{
  storeName: string;
  storePhone?: string;
  receiveDate: string;
  noticeLines?: readonly string[];
}>;

export type TicketPreviewLineDraft = Readonly<{
  service_code: string;
  category_code: string;
  unit_price_cents: number;
  qty: number;
}>;

/** service/category → "wash/shirt" display name. */
export function ticketLineName(serviceCode: string, categoryCode: string): string {
  return `${serviceCode}/${categoryCode}`;
}

export function toTicketPreviewLines(
  lines: readonly TicketPreviewLineDraft[] | readonly BuiltReceiveLine[],
): readonly TicketPreviewLine[] {
  return Object.freeze(
    lines.map((line) =>
      Object.freeze({
        name: ticketLineName(line.service_code, line.category_code),
        qty: line.qty,
        unit_price_cents: line.unit_price_cents,
      }),
    ),
  );
}

/**
 * Build domain TicketPreviewInput from receive result + form line drafts.
 */
export function buildTicketPreviewInputFromReceive(
  result: ReceiveOrderResult,
  lines: readonly TicketPreviewLineDraft[] | readonly BuiltReceiveLine[],
  opts: BuildTicketPreviewOpts,
): TicketPreviewInput {
  const input: {
    store_name: string;
    store_phone?: string;
    ticket_no: string;
    customer_name: string | null;
    customer_phone: string | null;
    receive_date: string;
    lines: readonly TicketPreviewLine[];
    payable_cents: number;
    paid_cents: number;
    balance_cents: number;
    notice_lines?: readonly string[];
  } = {
    store_name: opts.storeName,
    ticket_no: result.ticket_no,
    customer_name: null,
    customer_phone: null,
    receive_date: opts.receiveDate,
    lines: toTicketPreviewLines(lines),
    payable_cents: result.payable_cents,
    paid_cents: result.paid_cents,
    balance_cents: result.balance_cents,
  };
  if (opts.storePhone !== undefined) input.store_phone = opts.storePhone;
  if (opts.noticeLines !== undefined) input.notice_lines = opts.noticeLines;
  return Object.freeze(input);
}

export type BuildReceiveTicketPreviewArgs = Readonly<{
  result: ReceiveOrderResult;
  lines: readonly TicketPreviewLineDraft[] | readonly BuiltReceiveLine[];
  storeName: string;
  storePhone?: string | undefined;
  receiveDate: string;
  customerName?: string | null | undefined;
  customerPhone?: string | null | undefined;
  noticeLines?: readonly string[] | undefined;
}>;

/** Full preview for receive success (includes customer from form). */
export function buildReceiveTicketPreview(args: BuildReceiveTicketPreviewArgs): TicketPreview {
  const opts: {
    storeName: string;
    storePhone?: string;
    receiveDate: string;
    noticeLines?: readonly string[];
  } = {
    storeName: args.storeName,
    receiveDate: args.receiveDate,
  };
  if (args.storePhone !== undefined) opts.storePhone = args.storePhone;
  if (args.noticeLines !== undefined) opts.noticeLines = args.noticeLines;
  const base = buildTicketPreviewInputFromReceive(args.result, args.lines, opts);
  return renderTicketPreview(
    Object.freeze({
      ...base,
      customer_name: args.customerName ?? null,
      customer_phone: args.customerPhone ?? null,
    }),
  );
}

/** Local calendar date label YYYY-MM-DD (no I/O beyond Date). */
export function formatReceiveDateLabel(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function triggerBrowserPrint(): void {
  if (typeof window !== "undefined" && typeof window.print === "function") {
    window.print();
  }
}
