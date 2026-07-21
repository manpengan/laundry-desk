/**
 * Signed print-template local render (D4).
 * Pure: fen→￥ via money-gbk; CODE128 width plan via code128-width.
 * No I/O, no device paths, no business validation.
 */
import {
  estimateCode128Dots,
  fitsXp58,
  XP58_PRINTABLE_DOTS,
} from "../drivers/render/code128-width.js";
import { assertIntegerFen, fenToYuanGbk } from "../drivers/render/money-gbk.js";

export type TicketLineItem = Readonly<{
  name: string;
  qty: number;
  unitPriceFen: number;
}>;

/** Variables a signed storefront ticket template may bind. */
export type TicketTemplateInput = Readonly<{
  storeName: string;
  storePhone?: string;
  ticketNo: string;
  barcode: string;
  customerName: string;
  receiveDate: string;
  pickupDate?: string;
  lines: readonly TicketLineItem[];
  totalFen: number;
  paidFen: number;
  payMethod?: string;
  noticeLines?: readonly string[];
  /** GS w n module width; default 1 for 58mm. */
  barcodeModuleWidth?: number;
}>;

export type RenderedTicket = Readonly<{
  lines: readonly string[];
  totalText: string;
  paidText: string;
  barcode: string;
  /** CODE128 symbol count used for width plan (Set B: 1 char = 1 symbol). */
  barcodeSymbolCount: number;
  barcodeModuleWidth: number;
  barcodeDots: number;
  barcodeFitsXp58: boolean;
  printableDots: number;
}>;

function assertPositiveQty(qty: number): void {
  if (!Number.isInteger(qty) || qty < 1) {
    throw new Error(`line qty must be positive integer, got ${String(qty)}`);
  }
}

function lineAmountFen(item: TicketLineItem): number {
  assertIntegerFen(item.unitPriceFen);
  assertPositiveQty(item.qty);
  return item.unitPriceFen * item.qty;
}

/**
 * Render ticket text lines and money/barcode metadata for XP-58 ESC/POS.
 * Money fields accept integer fen only (throws otherwise).
 */
export function renderTicketTemplate(input: TicketTemplateInput): RenderedTicket {
  assertIntegerFen(input.totalFen);
  assertIntegerFen(input.paidFen);

  const moduleWidth = input.barcodeModuleWidth ?? 1;
  if (!Number.isInteger(moduleWidth) || moduleWidth < 1) {
    throw new Error(`barcodeModuleWidth must be positive integer, got ${String(moduleWidth)}`);
  }

  const barcode = input.barcode;
  // Set B estimate: each printable character is one CODE128 symbol.
  const barcodeSymbolCount = barcode.length;
  const barcodeDots = estimateCode128Dots(barcodeSymbolCount, moduleWidth);
  const barcodeFitsXp58 = fitsXp58(barcodeSymbolCount, moduleWidth);

  const totalText = fenToYuanGbk(input.totalFen);
  const paidText = fenToYuanGbk(input.paidFen);

  const lines: string[] = [input.storeName];
  if (input.storePhone) {
    lines.push(`电话 ${input.storePhone}`);
  }
  lines.push("--------------------------------");
  lines.push(`票单号 ${input.ticketNo}`);
  lines.push(
    input.pickupDate
      ? `收件 ${input.receiveDate}  可取 ${input.pickupDate}`
      : `收件 ${input.receiveDate}`,
  );
  lines.push(`顾客 ${input.customerName}`);
  lines.push("--------------------------------");
  lines.push("名称            数  金额");

  for (const item of input.lines) {
    const amount = fenToYuanGbk(lineAmountFen(item));
    lines.push(`${item.name}  x${item.qty}  ${amount}`);
  }

  lines.push("--------------------------------");
  lines.push(`合计 ${totalText}`);
  lines.push(input.payMethod ? `实收 ${paidText}  ${input.payMethod}` : `实收 ${paidText}`);
  lines.push(`条码 ${barcode}`);

  for (const notice of input.noticeLines ?? []) {
    lines.push(notice);
  }

  return Object.freeze({
    lines: Object.freeze(lines.slice()),
    totalText,
    paidText,
    barcode,
    barcodeSymbolCount,
    barcodeModuleWidth: moduleWidth,
    barcodeDots,
    barcodeFitsXp58,
    printableDots: XP58_PRINTABLE_DOTS,
  });
}
