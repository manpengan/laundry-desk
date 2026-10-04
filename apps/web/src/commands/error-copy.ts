import type { CommandFailure } from "./types.js";

/**
 * Counter-facing copy for the server's public command error codes. The server keeps
 * stable English messages for API clients; staff must see what happened and what to do.
 */
const CODE_COPY: Readonly<Record<string, string>> = Object.freeze({
  VALIDATION_FAILED: "填写的内容不符合要求，请检查后重试",
  CUSTOMER_ERASED: "该顾客资料已按要求删除，不能再使用",
  SHIFT_CLOSED: "当天营业日已日结，不能再修改当日账目",
  PERMISSION_DENIED: "当前账号没有这项操作的权限",
  RESOURCE_UNAVAILABLE: "数据已变化或暂时不可用，请刷新后重试",
  POLICY_CONFIRMATION_REQUIRED: "需要确认后才能继续",
  POLICY_STEP_UP_REQUIRED: "需要店长现场复核后才能继续",
  POLICY_APPROVAL_REQUIRED: "需要审批后才能继续",
  POLICY_DENIED: "当前规则不允许这项操作",
  INVARIANT_FAILED: "数据校验未通过，请刷新后重试",
  TRANSACTION_FAILED: "保存没有完成，请稍后重试；如果反复出现，请联系技术支持",
  EVENT_DISPATCH_FAILED: "已保存，但后续通知没有完成",
  IDEMPOTENCY_REPLAY_UNSUPPORTED: "这项操作不能重复提交",
  IDEMPOTENCY_CONFLICT: "同一次提交的内容前后不一致，请刷新后重试",
  REPLAY_ARBITRATION_REQUIRED: "离线记录需要人工核对",
  AUTHENTICATION_FAILED: "登录已失效，请重新登录",
  CSRF_REJECTED: "请求来源校验失败，请刷新页面后重试",
  RATE_LIMITED: "操作太频繁，请稍后再试",
});

/** A specific reason is more useful than its generic code. */
const REASON_COPY: Readonly<Record<string, string>> = Object.freeze({
  payment_pending:
    "该订单或会员账户有尚未结束的扫码收款或退款，请先在取衣页的“扫码收款”里查询结果或关闭收款",
  channel_refund_required: "这笔钱是微信或支付宝扫码收的，请使用原路退款",
  retry_later: "暂时无法完成，请稍后重试",
  idempotency_conflict: "同一次提交的内容前后不一致，请刷新后重试",
});

export function localizeFailure(failure: CommandFailure): CommandFailure {
  const reason = failure.detail?.reason;
  const text = (reason === undefined ? undefined : REASON_COPY[reason]) ?? CODE_COPY[failure.code];
  if (text === undefined) return failure;
  return Object.freeze({ ...failure, message: text });
}
