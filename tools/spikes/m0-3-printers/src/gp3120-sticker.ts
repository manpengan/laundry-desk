import {
  barcode,
  cls,
  concat,
  direction,
  gapMm,
  labelHeightDots,
  print,
  sizeMm,
  text,
} from "../lib/tspl.ts";
import { fenToYuanText } from "../lib/money.ts";
import {
  STICKER_VARS,
  type SampleOrder,
  type StickerVar,
} from "../lib/variables.ts";

function stickerValues(order: SampleOrder): Record<StickerVar, string> {
  const debt =
    order.debtFen > 0 ? `欠¥${fenToYuanText(order.debtFen)}` : "已清";
  return {
    名称: order.itemName,
    颜色: order.color,
    服务: order.service,
    单价: `¥${fenToYuanText(order.unitPriceFen)}`,
    件数: String(order.qty),
    序号: `${order.itemIndex}/${order.itemCount}`,
    挂点: order.hangPoint,
    品牌: order.brand,
    备注: order.remark,
    款式: order.style,
    附件: order.attachment,
    付款方式: `${order.payMethod}/${debt}`,
    姓名: order.customerName,
    电话: order.customerPhone,
    卡号: order.cardNo,
    职员: order.staffName,
    加急: order.urgent,
    票单号: order.ticketNo,
    条码号: order.barcode,
    收件日期: order.receiveDate,
    已消毒: order.disinfected,
    打开存放: order.openStorage,
  };
}

/**
 * Full-variable TSPL sticker.
 * 22 lines need height > 60mm: use 40×90mm (720dot) so BARCODE stays above edge.
 * Compact production layout remains 40×30.
 */
export function buildGp3120Sticker(order: SampleOrder): Buffer {
  const v = stickerValues(order);
  const heightMm = 90;
  const maxY = labelHeightDots(heightMm);
  const barH = 40;
  const marginBottom = 8;
  const parts: Buffer[] = [
    sizeMm(40, heightMm),
    gapMm(2, 0),
    direction(1),
    cls(),
    text(8, 8, "TSS24.BF2", "不干胶全变量", 1, 1, 0, 24),
    text(8, 32, "TSS16.BF2", `vars=${STICKER_VARS.length} h=${heightMm}mm`, 1, 1),
  ];

  let y = 52;
  const lineH = 26;
  for (const key of STICKER_VARS) {
    parts.push(text(8, y, "TSS16.BF2", `${key}:${v[key]}`, 1, 1, 0, 36));
    y += lineH;
  }

  const barY = Math.min(y + 6, maxY - barH - marginBottom);
  if (barY + barH + marginBottom > maxY) {
    throw new Error(
      `sticker layout overflow: barY=${barY} barH=${barH} maxY=${maxY}`,
    );
  }
  parts.push(barcode(8, barY, order.barcode, barH, 1), print(1, 1));
  return concat(...parts);
}

/** Compact 40×30 production-like layout. */
export function buildGp3120StickerCompact(order: SampleOrder): Buffer {
  const v = stickerValues(order);
  const heightMm = 30;
  const maxY = labelHeightDots(heightMm);
  const barH = 36;
  const barY = 150;
  if (barY + barH > maxY) {
    throw new Error(`compact sticker overflow: ${barY + barH} > ${maxY}`);
  }
  return concat(
    sizeMm(40, heightMm),
    gapMm(2, 0),
    direction(1),
    cls(),
    text(16, 8, "TSS24.BF2", `${v.名称} ${v.颜色}`, 1, 1, 0, 20),
    text(16, 36, "TSS16.BF2", `${v.服务} ${v.挂点} ${v.加急}`, 1, 1, 0, 28),
    text(16, 58, "TSS16.BF2", `${v.姓名} ${v.电话}`, 1, 1, 0, 28),
    text(16, 80, "TSS16.BF2", `${v.票单号} ${v.收件日期}`, 1, 1, 0, 28),
    text(16, 102, "TSS16.BF2", `${v.已消毒} 打开:${v.打开存放}`, 1, 1, 0, 28),
    barcode(16, barY, order.barcode, barH, 1),
    print(1, 1),
  );
}

export function listStickerVarsRendered(order: SampleOrder): string[] {
  const values = stickerValues(order);
  return STICKER_VARS.map((k) => `@${k}@=${values[k]}`);
}
