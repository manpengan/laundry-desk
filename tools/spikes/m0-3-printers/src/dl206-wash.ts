import {
  align,
  chineseOn,
  concat,
  cut,
  cutEscI,
  cutFeedFull,
  feed,
  hr,
  init,
  line,
  textSize,
} from "../lib/escpos.ts";
import { fenToYuanWithSign } from "../lib/money.ts";
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
    单价: fenToYuanWithSign(order.unitPriceFen),
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

function washBody(order: SampleOrder, title: string): Buffer[] {
  const values = washValues(order);
  const parts: Buffer[] = [
    init(),
    chineseOn(),
    align(0),
    textSize(0, 0),
    line(title),
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
  );
  return parts;
}

/** Full-variable wash label + immediate GS V 0 full cut (short feed). */
export function buildDl206WashLabel(order: SampleOrder): Buffer {
  return concat(...washBody(order, "【水洗唛全变量样张】"), feed(2), cut(0));
}

/**
 * ESC i cutter only (some DASCOM firmwares ignore GS V).
 * Field: if GS V does not cut, try this file instead.
 */
export function buildDl206WashLabelEscI(order: SampleOrder): Buffer {
  const values = washValues(order);
  return concat(
    init(),
    chineseOn(),
    line("【水洗唛 ESC i 切刀】"),
    line(`${values.名称} ${values.颜色} ${values.服务}`),
    line(`${values.单价} ${values.票单号}`),
    line(`${values.条码号}`),
    feed(3),
    cutEscI(),
  );
}

/**
 * Extra feed before cut — thermal knife is often 10–25mm past the print head.
 * feed(6) LF + GS V 66 n (feed-then-full-cut).
 */
export function buildDl206WashLabelFeedCut(order: SampleOrder): Buffer {
  return concat(
    ...washBody(order, "【水洗唛 feed+GS V 66 切刀】"),
    feed(6),
    cutFeedFull(3),
  );
}

export function listWashVarsRendered(order: SampleOrder): string[] {
  const values = washValues(order);
  return WASH_LABEL_VARS.map((k) => `@${k}@=${values[k]}`);
}
