import {
  barcode,
  cls,
  concat,
  direction,
  gapMm,
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
 * GP-3120 TSPL sticker. Default 40×30 mm; adjust SIZE/GAP on field if media differs.
 * Font TSS24.BF2 is stock on most Gprinter CN firmware.
 */
export function buildGp3120Sticker(order: SampleOrder): Buffer {
  const v = stickerValues(order);
  const yStep = 22;
  let y = 8;
  const parts: Buffer[] = [
    sizeMm(40, 60),
    gapMm(2, 0),
    direction(1),
    cls(),
    text(10, y, "TSS24.BF2", "不干胶全变量", 1, 1),
  ];
  y += yStep;
  parts.push(text(10, y, "TSS16.BF2", `vars=${STICKER_VARS.length}`, 1, 1));
  y += yStep;

  for (const key of STICKER_VARS) {
    parts.push(text(10, y, "TSS16.BF2", `${key}:${v[key]}`, 1, 1));
    y += 18;
  }

  parts.push(barcode(10, y + 4, order.barcode, 48, 1), print(1, 1));
  return concat(...parts);
}

/** Compact 40×30 production-like layout (4 lines, matches 顺科 shop template spirit). */
export function buildGp3120StickerCompact(order: SampleOrder): Buffer {
  const v = stickerValues(order);
  return concat(
    sizeMm(40, 30),
    gapMm(2, 0),
    direction(1),
    cls(),
    text(16, 10, "TSS24.BF2", `${v.名称} ${v.颜色}`, 1, 1),
    text(16, 40, "TSS16.BF2", `${v.服务} ${v.挂点} ${v.加急}`, 1, 1),
    text(16, 65, "TSS16.BF2", `${v.姓名} ${v.电话}`, 1, 1),
    text(16, 90, "TSS16.BF2", `${v.票单号} ${v.收件日期}`, 1, 1),
    text(16, 115, "TSS16.BF2", `${v.已消毒} 打开:${v.打开存放}`, 1, 1),
    barcode(16, 140, order.barcode, 40, 1),
    print(1, 1),
  );
}

export function listStickerVarsRendered(order: SampleOrder): string[] {
  const values = stickerValues(order);
  return STICKER_VARS.map((k) => `@${k}@=${values[k]}`);
}
