import type { SampleOrder } from "./variables.ts";

function baseOrder(): SampleOrder {
  return {
    storeName: "宏发洗衣（spike样张）",
    storePhone: "010-00000000",
    storeAddress: "测试路1号（虚构）",
    ticketNo: "20260719-0001",
    barcode: "LD20260719000101",
    staffName: "店员甲",
    customerName: "张三",
    customerPhone: "13800000138",
    cardNo: "C000138",
    payMethod: "微信",
    debtFen: 0,
    receiveDate: "2026-07-19",
    pickupDate: "2026-07-24",
    processStep: "收衣",
    itemIndex: 1,
    itemCount: 1,
    itemName: "羽绒服",
    color: "黑色",
    service: "干洗",
    unitPriceFen: 4500,
    qty: 1,
    hangPoint: "A-12",
    brand: "无品牌",
    remark: "袖口易污",
    style: "长款",
    attachment: "无",
    addon: "去渍",
    urgent: "否",
    disinfected: "已消毒",
    openStorage: "否",
    noticeLines: ["边界样张"],
    lines: [
      {
        name: "羽绒服",
        service: "干洗",
        color: "黑色",
        qty: 1,
        unitPriceFen: 4500,
      },
    ],
    totalFen: 4500,
    paidFen: 4500,
    phoneMask: true,
  };
}

/** All optional text fields empty — renderer must not throw. */
export function emptyVarsOrder(): SampleOrder {
  const o = baseOrder();
  return {
    ...o,
    storeAddress: "",
    cardNo: "",
    brand: "",
    remark: "",
    style: "",
    attachment: "",
    addon: "",
    hangPoint: "",
    disinfected: "",
    openStorage: "",
    noticeLines: [""],
  };
}

/** Long Chinese fields to exercise truncation on TSPL TEXT. */
export function longTextOrder(): SampleOrder {
  const long =
    "超长中文备注用于验证标签截断与小票折行：顾客交代衣物有特殊污渍需要重点处理并且不要使用含荧光剂洗涤剂还要分开包装";
  const o = baseOrder();
  return {
    ...o,
    storeName: `宏发洗衣（${long.slice(0, 20)}）`,
    itemName: long.slice(0, 24),
    remark: long,
    brand: long.slice(0, 30),
    attachment: long.slice(0, 30),
    noticeLines: [long, long],
  };
}

/** Special characters: @, ASCII quotes, newlines inside fields. */
export function specialCharsOrder(): SampleOrder {
  const o = baseOrder();
  return {
    ...o,
    customerName: '李"四',
    remark: '污渍@袖口\n勿熨"烫"',
    brand: 'Brand"X"@1',
    hangPoint: 'A-"12"',
    addon: "去渍@加强",
    noticeLines: ['含引号"与@符号', "第二行\n被展平"],
  };
}
