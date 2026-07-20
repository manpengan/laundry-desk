/**
 * Variable catalogs from 顺科矩阵 (IMG_2315 / IMG_2316).
 * Matrix says 21 wash / 22 sticker; parenthetical wash list has 23 tokens —
 * we implement every named token and record the count discrepancy in findings.
 */

export const WASH_LABEL_VARS = [
  "名称",
  "颜色",
  "服务",
  "单价",
  "件数",
  "序号",
  "挂点",
  "品牌",
  "备注",
  "款式",
  "附件",
  "付款方式",
  "姓名",
  "电话",
  "卡号",
  "职员",
  "附加",
  "加急",
  "票单号",
  "条码号",
  "收件日期",
  "取件日期",
  "工序",
] as const;

export const STICKER_VARS = [
  "名称",
  "颜色",
  "服务",
  "单价",
  "件数",
  "序号",
  "挂点",
  "品牌",
  "备注",
  "款式",
  "附件",
  "付款方式",
  "姓名",
  "电话",
  "卡号",
  "职员",
  "加急",
  "票单号",
  "条码号",
  "收件日期",
  "已消毒",
  "打开存放",
] as const;

export type WashVar = (typeof WASH_LABEL_VARS)[number];
export type StickerVar = (typeof STICKER_VARS)[number];

export type SampleOrder = {
  storeName: string;
  storePhone: string;
  storeAddress: string;
  ticketNo: string;
  barcode: string;
  staffName: string;
  customerName: string;
  customerPhone: string;
  cardNo: string;
  payMethod: string;
  debtFen: number;
  receiveDate: string;
  pickupDate: string;
  processStep: string;
  itemIndex: number;
  itemCount: number;
  itemName: string;
  color: string;
  service: string;
  unitPriceFen: number;
  qty: number;
  hangPoint: string;
  brand: string;
  remark: string;
  style: string;
  attachment: string;
  addon: string;
  urgent: string;
  disinfected: string;
  openStorage: string;
  noticeLines: string[];
  lines: Array<{
    name: string;
    service: string;
    color: string;
    qty: number;
    unitPriceFen: number;
  }>;
  totalFen: number;
  paidFen: number;
  phoneMask: boolean;
};
