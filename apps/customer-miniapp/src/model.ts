export function cents(value: number): string {
  return Number.isSafeInteger(value) ? `¥${(value / 100).toFixed(2)}` : "--";
}
export function amountCents(value: string): number {
  if (!/^(?:0|[1-9]\d{0,4})(?:\.\d{1,2})?$/u.test(value))
    throw new Error("请输入有效金额，最多两位小数");
  const [whole = "", decimal = ""] = value.split(".");
  const result = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
  if (result < 1 || result > 5_000_000) throw new Error("金额须为 0.01 至 50000 元");
  return result;
}
export const statusLabel = (value: string): string =>
  ({
    open: "处理中",
    closed: "已完成",
    cancelled: "已取消",
    received: "已收件",
    washing: "洗护中",
    ready: "待上架",
    racked: "待取件",
    picked_up: "已取件",
    delivered: "已送达",
    reworked: "返工中",
    lost: "门店处理中",
    scheduled: "已预约",
    created: "待付款",
    pending: "待确认",
    unknown: "结果待确认",
    paid: "已支付",
    needs_review: "待门店核查",
    active: "可用",
    frozen: "已冻结",
    exhausted: "已用完",
    expired: "已过期",
    redeemed: "已使用",
  })[value] ?? "状态更新中";

export function appointmentEpoch(date: string, time: string, timezone: string): number {
  if (!["Asia/Shanghai", "Asia/Taipei", "Asia/Hong_Kong"].includes(timezone))
    throw new Error("该门店时区暂不支持在线选择，请联系门店预约");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !/^\d{2}:\d{2}$/u.test(time))
    throw new Error("请选择日期和时间");
  const instant = Date.parse(`${date}T${time}:00+08:00`);
  if (
    !Number.isFinite(instant) ||
    new Date(instant + 8 * 3_600_000).toISOString().slice(0, 16) !== `${date}T${time}`
  )
    throw new Error("预约日期或时间无效");
  return instant / 1000;
}
export const localTime = (seconds: number): string =>
  new Date(seconds * 1000 + 8 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
