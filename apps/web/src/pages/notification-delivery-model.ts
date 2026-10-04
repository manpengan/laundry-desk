import {
  NotificationDeliveryBatchEnqueueInputSchema,
  NotificationDeliveryBatchEnqueueResultSchema,
  NotificationDeliveryBatchGetResultSchema,
  NotificationDeliveryBatchesListResultSchema,
  NotificationDeliveryCapabilityResultSchema,
  type NotificationDeliveryBatchEnqueueInput,
  type NotificationDeliveryBatchEnqueueResult,
  type NotificationDeliveryBatchGetResult,
  type NotificationDeliveryBatchSummary,
  type NotificationDeliveryCapabilityResult,
  type NotificationDeliveryStatus,
} from "@laundry/contracts";

import { unwrapQueryResult } from "./customer-model.js";
import type { PickupReminderFilterState } from "./pickup-reminder-model.js";

export type NotificationCapabilityCopy = Readonly<{
  title: string;
  description: string;
  actionLabel: string;
}>;

function freezeCounts(
  counts: NotificationDeliveryBatchSummary["counts"],
): NotificationDeliveryBatchSummary["counts"] {
  return Object.freeze({ ...counts });
}

function freezeBatch(batch: NotificationDeliveryBatchSummary): NotificationDeliveryBatchSummary {
  return Object.freeze({ ...batch, counts: freezeCounts(batch.counts) });
}

export function parseNotificationCapability(
  value: unknown,
): NotificationDeliveryCapabilityResult | null {
  const parsed = NotificationDeliveryCapabilityResultSchema.safeParse(unwrapQueryResult(value));
  if (!parsed.success) return null;
  return Object.freeze({
    ...parsed.data,
    channels: Object.freeze({ ...parsed.data.channels }),
    templates: parsed.data.templates.map((template) => Object.freeze({ ...template })),
  });
}

export function parseNotificationBatchList(
  value: unknown,
): readonly NotificationDeliveryBatchSummary[] | null {
  const parsed = NotificationDeliveryBatchesListResultSchema.safeParse(unwrapQueryResult(value));
  if (!parsed.success) return null;
  return Object.freeze(parsed.data.batches.map(freezeBatch));
}

export function parseNotificationBatchDetail(
  value: unknown,
): NotificationDeliveryBatchGetResult | null {
  const parsed = NotificationDeliveryBatchGetResultSchema.safeParse(unwrapQueryResult(value));
  if (!parsed.success) return null;
  return Object.freeze({
    batch: freezeBatch(parsed.data.batch),
    deliveries: parsed.data.deliveries.map((delivery) => Object.freeze({ ...delivery })),
  });
}

export function parseNotificationEnqueueResult(
  value: unknown,
): NotificationDeliveryBatchEnqueueResult | null {
  const parsed = NotificationDeliveryBatchEnqueueResultSchema.safeParse(unwrapQueryResult(value));
  return parsed.success ? Object.freeze({ ...parsed.data }) : null;
}

export function buildNotificationEnqueueInput(
  orderIds: readonly string[],
  filters: PickupReminderFilterState,
  capability: NotificationDeliveryCapabilityResult,
): NotificationDeliveryBatchEnqueueInput | null {
  const template = capability.templates.find(
    (candidate) => candidate.code === "pickup_reminder_v1" && candidate.channel === "sms",
  );
  const unitCost = capability.unit_cost_cents;
  const providerLimit = capability.max_batch_cost_cents;
  if (
    capability.state === "disabled" ||
    template === undefined ||
    unitCost === null ||
    providerLimit === null
  ) {
    return null;
  }
  const estimatedCost = unitCost * orderIds.length;
  if (!Number.isSafeInteger(estimatedCost) || estimatedCost > providerLimit) return null;
  const parsed = NotificationDeliveryBatchEnqueueInputSchema.safeParse({
    order_ids: [...orderIds],
    channel: "sms",
    template_code: template.code,
    max_cost_cents: estimatedCost,
    min_age_days: filters.minAgeDays,
    unpaid_only: filters.unpaidOnly,
    garment_statuses: [...filters.statuses],
  });
  if (!parsed.success) return null;
  return Object.freeze({
    ...parsed.data,
    order_ids: [...parsed.data.order_ids],
    garment_statuses: [...parsed.data.garment_statuses],
  });
}

export function notificationCapabilityCopy(
  capability: NotificationDeliveryCapabilityResult,
): NotificationCapabilityCopy {
  if (capability.state === "disabled") {
    return Object.freeze({
      title: "自动通知未启用",
      description: "当前只能生成人工名单；系统不会发送短信或微信。",
      actionLabel: "通知通道不可用",
    });
  }
  if (capability.state === "software_only") {
    return Object.freeze({
      title: "软件模拟模式",
      description: "只验证入队、重试和状态机，不会发出短信，也没有外部回执证据。",
      actionLabel: "加入软件模拟队列",
    });
  }
  return Object.freeze({
    title: "外部短信通道已配置",
    description: "入队不等于发送；只有验签后的通道回执才可显示为送达。",
    actionLabel: "加入短信队列",
  });
}

export function notificationBatchStatusLabel(
  status: NotificationDeliveryBatchSummary["status"],
): string {
  const labels = {
    queued: "待处理",
    processing: "处理中",
    completed: "已完成",
    attention_required: "需要人工处理",
    cancelled: "已取消",
  } as const;
  return labels[status];
}

export function notificationDeliveryStatusLabel(
  status: NotificationDeliveryStatus,
  assurance: NotificationDeliveryBatchSummary["assurance"],
): string {
  if (assurance === "software_only") {
    const softwareLabels: Record<NotificationDeliveryStatus, string> = {
      queued: "等待软件模拟",
      sending: "软件模拟处理中",
      retry_wait: "软件模拟等待重试",
      accepted: "软件模拟已接单（未发送）",
      delivered: "软件模拟完成（无外部回执）",
      manual_required: "转人工联系",
      cancelled: "已取消",
    };
    return softwareLabels[status];
  }
  const externalLabels: Record<NotificationDeliveryStatus, string> = {
    queued: "等待通道处理",
    sending: "通道请求中",
    retry_wait: "等待重试",
    accepted: "通道已接单",
    delivered: "回执确认送达",
    manual_required: "转人工联系",
    cancelled: "已取消",
  };
  return externalLabels[status];
}

/** ADR-77 r1: why a delivery stopped, in words staff can act on. */
const ERROR_TEXT: Readonly<Record<string, string>> = Object.freeze({
  ALIYUN_ACCESS_KEY_INVALID: "AccessKey 无效：请在设置里重新填写阿里云 AccessKey",
  ALIYUN_SECRET_INVALID: "AccessKey Secret 不正确：请在设置里重新填写",
  ALIYUN_ACCOUNT_DENIED: "阿里云账号无短信权限或状态异常",
  ALIYUN_SIGN_NAME_INVALID: "短信签名未通过审核或填写错误",
  ALIYUN_TEMPLATE_INVALID: "模板编码不存在或未通过审核",
  ALIYUN_TEMPLATE_PARAMS_INVALID: "模板变量不匹配：模板须使用 tickets、garment_count、balance_yuan",
  ALIYUN_PHONE_INVALID: "顾客手机号格式不正确",
  ALIYUN_RATE_LIMITED: "触发阿里云发送频率限制，请稍后再发",
  ALIYUN_BALANCE_INSUFFICIENT: "阿里云短信余额不足",
  ALIYUN_REQUEST_REJECTED: "阿里云拒绝了这条短信",
  ALIYUN_INPUT_INVALID: "票号或金额不符合短信要求，没有发送",
  ALIYUN_CREDENTIAL_UNAVAILABLE: "本机无法读取短信密钥，没有发送",
  ALIYUN_NOT_SENT: "网络不可用，短信没有发出",
  ALIYUN_SYSTEM_BUSY: "阿里云系统繁忙，短信没有发出",
  ALIYUN_OUTCOME_UNKNOWN: "发送结果不明：请先核对阿里云发送记录，避免重复发送",
  PROVIDER_CONFIGURATION_CHANGED: "短信设置已变更，本条未发送",
  PROVIDER_PRIOR_OUTCOME_UNKNOWN: "上次发送结果不明，系统不会重复发送",
  COST_LIMIT_EXCEEDED: "超出本批费用上限，未发送",
  TARGET_SNAPSHOT_CHANGED: "订单或顾客信息已变化，未发送",
});

export function notificationErrorText(code: string | null): string {
  if (code === null) return "无错误";
  return ERROR_TEXT[code] ?? `未完成（${code}）`;
}

export function notificationDeliveredCountLabel(
  assurance: NotificationDeliveryBatchSummary["assurance"],
): string {
  return assurance === "software_only" ? "软件模拟完成" : "回执确认";
}

export function notificationAcceptedCountLabel(
  assurance: NotificationDeliveryBatchSummary["assurance"],
): string {
  return assurance === "software_only" ? "软件模拟已接单" : "通道已接单";
}

export function manualFallbackOrderIds(
  detail: NotificationDeliveryBatchGetResult,
): readonly string[] {
  return Object.freeze(
    detail.deliveries
      .filter((delivery) => delivery.status === "manual_required")
      .map((delivery) => delivery.order_id),
  );
}

export function formatNotificationTime(value: string | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return value.replace("T", " ").slice(0, 16);
}
