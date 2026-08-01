import { PrintSnapshotSchema, type PrintSnapshot } from "@laundry/contracts";

import { fenToYuanGbk } from "../drivers/render/money-gbk.js";
import { buildXp58EscPos } from "./escpos-xp58.js";
import {
  renderTicketTemplate,
  type RenderedTicket,
  type TicketLineItem,
  type TicketTemplateInput,
} from "./template-render.js";

const PAYMENT_LABELS = Object.freeze({
  cash: "现金",
  wechat: "微信",
  alipay: "支付宝",
  other: "其他",
  balance: "储值余额",
});
const PRINTABLE_ASCII = /^[\x20-\x7e]{1,29}$/u;

export type RenderedPrintSnapshot = Readonly<{
  snapshot: PrintSnapshot;
  ticket: RenderedTicket;
  bytes: Uint8Array<ArrayBufferLike>;
}>;

function itemName(line: PrintSnapshot["lines"][number]): string {
  return [line.category_code, line.service_code, line.brand, line.color]
    .filter((value): value is string => value !== null)
    .join("/");
}

function paymentLabel(snapshot: PrintSnapshot): string | undefined {
  if (snapshot.payment_methods.length === 0) return undefined;
  return snapshot.payment_methods.map((method) => PAYMENT_LABELS[method]).join("+");
}

function barcode(snapshot: PrintSnapshot): string {
  return PRINTABLE_ASCII.test(snapshot.ticket_no)
    ? snapshot.ticket_no
    : snapshot.order_id.replaceAll("-", "").slice(0, 28);
}

function noticeLines(snapshot: PrintSnapshot): readonly string[] {
  const lines: string[] = [];
  if (snapshot.totals.balance_cents > 0) {
    lines.push(`待付 ${fenToYuanGbk(snapshot.totals.balance_cents)}`);
  }
  if (snapshot.note !== null) lines.push(`备注 ${snapshot.note}`);
  return Object.freeze(lines);
}

function ticketInput(snapshot: PrintSnapshot): TicketTemplateInput {
  const lines: readonly TicketLineItem[] = Object.freeze(
    snapshot.lines.map((line) =>
      Object.freeze({
        name: itemName(line),
        qty: line.qty,
        unitPriceFen: line.unit_price_cents,
        lineTotalFen: line.line_total_cents,
      }),
    ),
  );
  const payMethod = paymentLabel(snapshot);
  return Object.freeze({
    storeName: snapshot.store_name,
    ...(snapshot.store_phone === null ? {} : { storePhone: snapshot.store_phone }),
    ticketNo: snapshot.ticket_no,
    barcode: barcode(snapshot),
    ...(snapshot.customer_name === null ? {} : { customerName: snapshot.customer_name }),
    ...(snapshot.customer_phone === null ? {} : { customerPhone: snapshot.customer_phone }),
    receiveDate: snapshot.received_at.slice(0, 10),
    lines,
    totalFen: snapshot.totals.payable_cents,
    paidFen: snapshot.totals.paid_cents,
    ...(payMethod === undefined ? {} : { payMethod }),
    noticeLines: noticeLines(snapshot),
    barcodeModuleWidth: 1,
  });
}

/** Strictly parse and render only the immutable server snapshot as XP-58 ESC/POS. */
export function renderPrintSnapshot(input: unknown): RenderedPrintSnapshot {
  const snapshot = PrintSnapshotSchema.parse(input);
  const ticket = renderTicketTemplate(ticketInput(snapshot));
  const bytes = buildXp58EscPos(ticket);
  return Object.freeze({ snapshot, ticket, bytes });
}
