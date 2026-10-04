import type { ChannelIntent, ChannelReconcileInput } from "@laundry/contracts";
import { readChannelStatement } from "./channel-statement.js";
export const channelStateLabels = Object.freeze({
  created: "正在生成",
  pending: "等待顾客付款",
  unknown: "结果待确认",
  paid: "渠道已确认收款",
  closed: "已关闭",
  needs_review: "需要店长核对",
  refunded: "渠道已确认退款",
  failed: "退款失败",
});

const ERROR_TEXT: ReadonlyArray<readonly [string, string]> = [
  ["CHANNEL_NOT_SENT", "网络不可用，收款码没有生成；请检查网络后重新生成。"],
  ["CHANNEL_REJECTED", "渠道拒绝了这笔收款，请让店长检查商户设置。"],
  ["CHANNEL_EXPIRED", "收款码已过期，已自动关闭。"],
  ["CHANNEL_CLOSED_BY_STAFF", "已关闭这笔扫码收款。"],
  ["CHANNEL_MANUAL_CLOSED", "店长已人工核销这笔收款。"],
  ["CHANNEL_AWAITING_PROVIDER", "正在等待渠道响应。"],
  ["CHANNEL_TRANSPORT_FAILED", "与渠道的连接中断，结果待确认，系统会自动查询。"],
  ["CHANNEL_SIGNATURE_INVALID", "渠道应答无法验证，结果待确认，系统会自动查询。"],
  ["CHANNEL_RESPONSE_INVALID", "渠道应答格式异常，结果待确认，系统会自动查询。"],
  ["CHANNEL_ORDER_NOT_FOUND", "渠道暂时查不到这笔订单，过期后会自动关闭。"],
  ["CHANNEL_BINDING_MISMATCH", "渠道应答与这笔单不一致，需要店长核对。"],
  ["CHANNEL_REVIEW_REQUIRED", "长时间无法确认结果，需要店长在设置页核对。"],
  ["CHANNEL_LEDGER", "渠道已确认收款，记账稍后会自动完成。"],
];

/** Staff-facing explanation of an intent's last error code; null when there is nothing to say. */
export function channelErrorText(code: string | null): string | null {
  if (code === null) return null;
  const match = ERROR_TEXT.find(([prefix]) => code.startsWith(prefix));
  if (match === undefined) return "结果待确认，请稍后查询。";
  // Keep the provider's own code visible so a merchant misconfiguration can be found.
  const provider = code.startsWith("CHANNEL_REJECTED_")
    ? code.slice("CHANNEL_REJECTED_".length)
    : "";
  return provider === "" ? match[1] : `${match[1]}（渠道代码 ${provider}）`;
}

/** Open intents hold the order: only these may show a code or be closed. */
export const OPEN_CHANNEL_STATES = Object.freeze(["created", "pending", "unknown", "needs_review"]);
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
/** Canonical-CSV compatible entry point; official bills go through readChannelStatement. */
export function parseChannelStatement(
  channel: "wechat" | "alipay",
  businessDate: string,
  text: string,
): ChannelReconcileInput {
  return readChannelStatement(channel, businessDate, text).input;
}
