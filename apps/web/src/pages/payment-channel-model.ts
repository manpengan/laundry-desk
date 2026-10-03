import {
  ChannelReconcileInputSchema,
  type ChannelIntent,
  type ChannelReconcileInput,
} from "@laundry/contracts";
export const channelStateLabels = Object.freeze({
  created: "已创建",
  pending: "等待渠道确认",
  unknown: "结果未知，请查询",
  paid: "渠道已确认收款",
  closed: "已关闭",
  needs_review: "需要人工核对",
  refunded: "渠道已确认退款",
  failed: "退款失败",
});
export function paymentQrAllowed(intent: ChannelIntent): boolean {
  if (!intent.qr_url || intent.state !== "pending" || Date.parse(intent.expires_at) <= Date.now())
    return false;
  try {
    const url = new URL(intent.qr_url);
    if (url.username || url.password || url.hash) return false;
    return intent.channel === "wechat"
      ? url.protocol === "weixin:" && url.hostname === "wxpay"
      : url.protocol === "https:" && url.hostname === "qr.alipay.com";
  } catch {
    return false;
  }
}
export function parseChannelStatement(
  channel: "wechat" | "alipay",
  businessDate: string,
  text: string,
): ChannelReconcileInput {
  if (text.length > 2_000_000 || !/^\d{4}-\d{2}-\d{2}$/u.test(businessDate))
    throw new Error("账单或日期格式不正确");
  const stamp = Date.parse(`${businessDate}T00:00:00Z`);
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== businessDate)
    throw new Error("日期不存在");
  const lines = text
    .replace(/^\uFEFF/u, "")
    .trim()
    .split(/\r?\n/u);
  if (lines.shift() !== "商户订单号,渠道订单号,金额分,类型,商户退款号")
    throw new Error("请使用页面说明的规范 CSV 列标题");
  if (lines.length === 0 || lines.length > 10000) throw new Error("每次导入 1–10000 行");
  const rows = lines.map((line) => {
    const parts = line.split(",");
    if (parts.length !== 5 || !/^[1-9]\d{0,6}$/u.test(parts[2] ?? ""))
      throw new Error("每行须包含五列，金额使用正整数分");
    return {
      merchant_order: parts[0],
      provider_order: parts[1],
      amount_cents: Number(parts[2]),
      kind: parts[3] === "收款" ? "payment" : parts[3] === "退款" ? "refund" : "invalid",
      merchant_refund: parts[4] || null,
    };
  });
  const parsed = ChannelReconcileInputSchema.safeParse({
    channel,
    business_date: businessDate,
    rows,
  });
  if (!parsed.success) throw new Error("请检查订单号、退款号、类型及金额；每笔最多 50000 元");
  return parsed.data;
}
