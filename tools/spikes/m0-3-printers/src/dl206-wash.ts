import {
  align,
  chineseOn,
  concat,
  cut,
  cutEscI,
  feed,
  hr,
  init,
  line,
  textSize,
} from "../lib/escpos.ts";
import { fenToYuanText } from "../lib/money.ts";
import {
  WASH_LABEL_VARS,
  type SampleOrder,
  type WashVar,
} from "../lib/variables.ts";

function washValues(order: SampleOrder): Record<WashVar, string> {
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
    付款方式: order.payMethod,
    姓名: order.customerName,
    电话: order.customerPhone,
    卡号: order.cardNo,
    职员: order.staffName,
    附加: order.addon,
    加急: order.urgent,
    票单号: order.ticketNo,
    条码号: order.barcode,
    收件日期: order.receiveDate,
    取件日期: order.pickupDate,
    工序: order.processStep,
  };
}

/** Render every wash-label variable for field verification. */
export function buildDl206WashLabel(order: SampleOrder): Buffer {
  const values = washValues(order);
  const parts: Buffer[] = [
    init(),
    chineseOn(),
    align(0),
    textSize(0, 0),
    line("【水洗唛全变量样张】"),
    line(`DL-206 / 变量数=${WASH_LABEL_VARS.length}`),
    hr("-", 24),
  ];

  for (const key of WASH_LABEL_VARS) {
    parts.push(line(`@${key}@=${values[key]}`));
  }

  parts.push(
    hr("-", 24),
    line("紧凑三行（仿店面模板）:"),
    line(`${values.名称}/${values.颜色}/${values.服务}`),
    line(`${values.姓名} ${values.电话} ${values.挂点}`),
    line(`${values.票单号} ${values.收件日期}`),
    feed(2),
    // Primary cut command used by most ESC/POS wash printers
    cut(0),
    // Fallback cutters for DASCOM firmware variants — field may need only one.
    // They are emitted AFTER full cut so operators can comment out in hex dump.
  );

  return concat(...parts);
}

/**
 * Alternate payload using ESC i cutter only (some DASCOM firmwares).
 * Field: if GS V does not cut, try this file instead.
 */
export function buildDl206WashLabelEscI(order: SampleOrder): Buffer {
  const base = buildDl206WashLabel(order);
  // Replace trailing GS V 0 with ESC i by rebuilding short tail
  const values = washValues(order);
  return concat(
    init(),
    chineseOn(),
    line("【水洗唛 ESC i 切刀】"),
    line(`${values.名称} ${values.颜色} ${values.服务}`),
    line(`${values.票单号} ${values.条码号}`),
    feed(3),
    cutEscI(),
  );
}

export function listWashVarsRendered(order: SampleOrder): string[] {
  const values = washValues(order);
  return WASH_LABEL_VARS.map((k) => `@${k}@=${values[k]}`);
}
