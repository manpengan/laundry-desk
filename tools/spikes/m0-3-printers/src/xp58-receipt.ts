import {
  align,
  barcodeCode128,
  bold,
  chineseOn,
  concat,
  cut,
  feed,
  hr,
  init,
  line,
  textSize,
  type Code128Mode,
  type Code128Options,
} from "../lib/escpos.ts";
import { maskPhone } from "../lib/encode.ts";
import { fenToYuanText } from "../lib/money.ts";
import type { SampleOrder } from "../lib/variables.ts";

export type Xp58BarcodeVariant = {
  label: string;
  options: Code128Options;
};

/** Field variants when default barcode does not print/scan. */
export const XP58_BARCODE_VARIANTS: readonly Xp58BarcodeVariant[] = [
  { label: "bc-w1", options: { mode: "BC", moduleWidth: 1, height: 56 } },
  { label: "b-w1", options: { mode: "B", moduleWidth: 1, height: 56 } },
  { label: "bc-w2", options: { mode: "BC", moduleWidth: 2, height: 56 } },
  { label: "b-w2", options: { mode: "B", moduleWidth: 2, height: 48 } },
] as const;

/** XP-58 58mm receipt (ESC/POS). Default: CODE128 {B/{C mix, GS w 1. */
export function buildXp58Receipt(
  order: SampleOrder,
  barcodeOptions: Code128Options = { mode: "BC", moduleWidth: 1 },
): Buffer {
  const phone = maskPhone(order.customerPhone, order.phoneMask);
  const mode = (barcodeOptions.mode ?? "BC") as Code128Mode;
  const parts: Buffer[] = [
    init(),
    chineseOn(),
    align(1),
    textSize(1, 1),
    bold(true),
    line(order.storeName),
    bold(false),
    textSize(0, 0),
    line(`电话 ${order.storePhone}`),
    line(order.storeAddress),
    align(0),
    hr(),
    line(`票单号 ${order.ticketNo}`),
    line(`收件 ${order.receiveDate}  可取 ${order.pickupDate}`),
    line(`顾客 ${order.customerName}  ${phone}`),
    line(`卡号 ${order.cardNo}  职员 ${order.staffName}`),
    hr(),
    line("名称     服务  色  数  金额"),
  ];

  for (const row of order.lines) {
    const amount = fenToYuanText(row.unitPriceFen * row.qty);
    parts.push(
      line(
        `${row.name} ${row.service} ${row.color} x${row.qty} ¥${amount}`,
      ),
    );
  }

  parts.push(
    hr(),
    bold(true),
    line(`合计 ¥${fenToYuanText(order.totalFen)}`),
    line(`实收 ¥${fenToYuanText(order.paidFen)}  ${order.payMethod}`),
    bold(false),
  );

  if (order.debtFen > 0) {
    parts.push(line(`欠款 ¥${fenToYuanText(order.debtFen)}`));
  }

  parts.push(
    hr(),
    align(1),
    line(`CODE128 mode=${mode} w=${barcodeOptions.moduleWidth ?? 1}`),
    barcodeCode128(order.barcode, barcodeOptions),
    align(0),
  );

  for (const notice of order.noticeLines) {
    parts.push(line(notice));
  }

  parts.push(
    feed(2),
    line("--- M0-3 XP-58 sample ---"),
    feed(3),
    cut(1),
  );

  return concat(...parts);
}

export function buildXp58ReceiptVariant(
  order: SampleOrder,
  variant: Xp58BarcodeVariant,
): Buffer {
  return buildXp58Receipt(order, variant.options);
}
