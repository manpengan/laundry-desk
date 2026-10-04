import assert from "node:assert/strict";
import test from "node:test";
import { decodeStatement, readChannelStatement } from "./channel-statement.js";

const ours = (digit: string) => digit.repeat(32);
const WECHAT_HEADER =
  "交易时间,公众账号ID,商户号,特约商户号,设备号,微信订单号,商户订单号,用户标识,交易类型,交易状态,付款银行,货币种类,应结订单金额,代金券金额,微信退款单号,商户退款单号,退款金额,充值券退款金额,退款类型,退款状态,商品名称,商户数据包,手续费,费率,订单金额,申请退款金额,费率备注";
const wechatLine = (cells: readonly string[]) => cells.map((cell) => "`" + cell).join(",");
const wechatRow = (
  status: string,
  order: string,
  amounts: Readonly<{ settle: string; refund?: string; total: string; applied?: string }>,
  refundNo = "",
) =>
  wechatLine([
    "2026-10-03 10:00:00",
    "wx0000000000000000",
    "1900000109",
    "",
    "",
    "4200000000202610030000000001",
    order,
    "oUpF8uMuAJO_M2pxb1Q9zNjWeS6o",
    "NATIVE",
    status,
    "OTHERS",
    "CNY",
    amounts.settle,
    "0.00",
    refundNo === "" ? "" : "50000000000000000000000001",
    refundNo,
    amounts.refund ?? "0.00",
    "0.00",
    refundNo === "" ? "" : "ORIGINAL",
    refundNo === "" ? "" : "SUCCESS",
    "洗衣订单, 含加急",
    "",
    "0.12",
    "0.60%",
    amounts.total,
    amounts.applied ?? "0.00",
    "",
  ]);

test("WeChat trade bill rows become exact cents, keyed by our merchant numbers", () => {
  const text = [
    WECHAT_HEADER,
    wechatRow("SUCCESS", ours("a"), { settle: "20.00", total: "20.00" }),
    wechatRow(
      "REFUND",
      ours("a"),
      { settle: "0.00", refund: "5.50", total: "0.00", applied: "5.50" },
      ours("b"),
    ),
    wechatRow("REVOKED", ours("c"), { settle: "1.00", total: "1.00" }),
    wechatRow("SUCCESS", "OTHER-TERMINAL-1", { settle: "9.90", total: "9.90" }),
    "总交易单数,应结订单总金额,退款总金额,充值券退款总金额,手续费总金额,订单总金额,申请退款总金额",
    wechatLine(["3", "21.00", "5.50", "0.00", "0.12", "21.00", "5.50"]),
  ].join("\r\n");
  const parsed = readChannelStatement("wechat", "2026-10-03", text);
  assert.equal(parsed.source, "wechat");
  assert.equal(parsed.skipped, 2);
  assert.deepEqual(parsed.input.rows, [
    {
      merchant_order: ours("a"),
      provider_order: "4200000000202610030000000001",
      amount_cents: 2000,
      kind: "payment",
      merchant_refund: null,
    },
    {
      merchant_order: ours("a"),
      provider_order: "4200000000202610030000000001",
      amount_cents: 550,
      kind: "refund",
      merchant_refund: ours("b"),
    },
  ]);
  assert.throws(() => readChannelStatement("alipay", "2026-10-03", text), /渠道选为微信/u);
});

const ALIPAY_HEADER =
  "支付宝交易号,商户订单号,业务类型,商品名称,创建时间,完成时间,门店编号,门店名称,操作员,终端号,对方账户,订单金额（元）,商家实收（元）,支付宝红包（元）,集分宝（元）,支付宝优惠（元）,商家优惠（元）,券核销金额（元）,券名称,商家红包消费金额（元）,卡消费金额（元）,退款批次号/请求号,服务费（元）,分润（元）,备注";
const alipayRow = (trade: string, order: string, type: string, amount: string, batch = "") =>
  [
    `${trade}\t`,
    `${order}\t`,
    type,
    "洗衣订单",
    "2026-10-03 10:00:00",
    "2026-10-03 10:00:30",
    "",
    "",
    "",
    "",
    "buy***@example.com",
    amount,
    amount,
    "0.00",
    "0.00",
    "0.00",
    "0.00",
    "0.00",
    "",
    "0.00",
    "0.00",
    batch === "" ? "" : `${batch}\t`,
    "-0.12",
    "0.00",
    "",
  ].join(",");

test("Alipay business detail rows become exact cents and refunds lose their sign", () => {
  const text = [
    "#支付宝业务明细查询",
    "#账号：[20880000000000000156]",
    "#起始日期：[2026年10月03日 00:00:00]   终止日期：[2026年10月04日 00:00:00]",
    "#-----------------------------------------业务明细列表----------------------------------------",
    ALIPAY_HEADER,
    alipayRow("2026100322001400000000000001", ours("d"), "交易", "35.80"),
    alipayRow("2026100322001400000000000001", ours("d"), "退款", "-35.80", ours("e")),
    alipayRow("2026100322001400000000000002", "x", "交易", "1.00"),
    "#-----------------------------------------业务明细列表结束------------------------------------",
    "#交易合计：2笔，商家实收共36.80元，商家优惠共0.00元",
  ].join("\n");
  const parsed = readChannelStatement("alipay", "2026-10-03", text);
  assert.equal(parsed.source, "alipay");
  assert.equal(parsed.skipped, 1);
  assert.deepEqual(
    parsed.input.rows.map((row) => [row.kind, row.amount_cents, row.merchant_refund]),
    [
      ["payment", 3580, null],
      ["refund", 3580, ours("e")],
    ],
  );
  assert.equal(parsed.input.rows[0]?.provider_order, "2026100322001400000000000001");
});

test("statement rejects unknown layouts, bad amounts and bills with nothing of ours", () => {
  assert.throws(() => readChannelStatement("wechat", "2026-10-03", "a,b,c\n1,2,3"), /无法识别/u);
  const bad = [
    WECHAT_HEADER,
    wechatRow("SUCCESS", ours("a"), { settle: "20.001", total: "20.001" }),
  ];
  assert.throws(() => readChannelStatement("wechat", "2026-10-03", bad.join("\n")), /第 2 行/u);
  const foreign = [WECHAT_HEADER, wechatRow("SUCCESS", "X1", { settle: "1.00", total: "1.00" })];
  assert.throws(
    () => readChannelStatement("wechat", "2026-10-03", foreign.join("\n")),
    /没有本系统/u,
  );
  assert.throws(() => readChannelStatement("wechat", "2026-13-03", WECHAT_HEADER), /日期/u);
});

test("GBK bills decode; UTF-8 bills stay untouched", () => {
  const gbk = Uint8Array.from([
    214, 167, 184, 182, 177, 166, 189, 187, 210, 215, 186, 197, 44, 201, 204, 187, 167, 182, 169,
    181, 165, 186, 197, 44, 210, 181, 206, 241, 192, 224, 208, 205, 10,
  ]);
  assert.equal(decodeStatement(gbk.buffer), "支付宝交易号,商户订单号,业务类型\n");
  const utf8 = new TextEncoder().encode("交易时间,微信订单号");
  assert.equal(decodeStatement(utf8.buffer as ArrayBuffer), "交易时间,微信订单号");
});
