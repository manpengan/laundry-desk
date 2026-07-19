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
} from "../lib/escpos.ts";
import { maskPhone } from "../lib/encode.ts";
import { fenToYuanText } from "../lib/money.ts";
import type { SampleOrder } from "../lib/variables.ts";

/** XP-58 58mm receipt (ESC/POS). ~32 GBK columns. */
export function buildXp58Receipt(order: SampleOrder): Buffer {
  const phone = maskPhone(order.customerPhone, order.phoneMask);
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

  parts.push(hr(), align(1), barcodeCode128(order.barcode), align(0));

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
