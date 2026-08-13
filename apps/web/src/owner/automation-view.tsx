import type { AutomationPolicy, AutomationRun } from "@laundry/contracts";

import type { AutomationFormValue } from "./automation-model.js";

export const AUTOMATION_STATUS_LABEL: Readonly<Record<AutomationPolicy["status"], string>> =
  Object.freeze({
    pending_approval: "待批准",
    active: "运行中",
    paused: "已暂停",
    quota_paused: "额度暂停",
    archived: "已归档",
  });

export const AUTOMATION_OUTCOME_LABEL: Readonly<Record<AutomationRun["outcome"], string>> =
  Object.freeze({
    executed: "已执行",
    failed: "失败",
    skipped: "无对象跳过",
    denied: "策略拒绝",
  });

export function formatAutomationTime(value: string | null): string {
  return value === null ? "—" : new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function AutomationField({
  label,
  value,
  type = "text",
  onChange,
}: Readonly<{
  label: string;
  value: string;
  type?: "text" | "time" | "number";
  onChange: (value: string) => void;
}>) {
  return (
    <label className="ld-owner-automation__field">
      <span>{label}</span>
      <input type={type} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

export function AutomationPolicyEditorFields({
  value,
  onChange,
}: Readonly<{
  value: AutomationFormValue;
  onChange: (value: AutomationFormValue) => void;
}>) {
  const set = <TKey extends keyof AutomationFormValue>(
    key: TKey,
    next: AutomationFormValue[TKey],
  ): void => onChange(Object.freeze({ ...value, [key]: next }));
  return (
    <div className="ld-owner-automation__form">
      <AutomationField label="策略名称" value={value.name} onChange={(next) => set("name", next)} />
      <AutomationField
        label="每日执行时间"
        type="time"
        value={value.localTime}
        onChange={(next) => set("localTime", next)}
      />
      <label className="ld-owner-automation__field">
        <span>最少滞留天数</span>
        <select
          value={value.minAgeDays}
          onChange={(event) => set("minAgeDays", event.target.value)}
        >
          <option value="30">30 天</option>
          <option value="90">90 天</option>
          <option value="180">180 天</option>
        </select>
      </label>
      <label className="ld-owner-automation__check">
        <input
          type="checkbox"
          checked={value.unpaidOnly}
          onChange={(event) => set("unpaidOnly", event.target.checked)}
        />
        <span>仅欠款订单</span>
      </label>
      <label className="ld-owner-automation__check">
        <input
          type="checkbox"
          checked={value.includeReady}
          onChange={(event) => set("includeReady", event.target.checked)}
        />
        <span>包含待取件</span>
      </label>
      <label className="ld-owner-automation__check">
        <input
          type="checkbox"
          checked={value.includeRacked}
          onChange={(event) => set("includeRacked", event.target.checked)}
        />
        <span>包含已上架</span>
      </label>
      <AutomationField
        label="每次最多订单"
        type="number"
        value={value.maxObjects}
        onChange={(next) => set("maxObjects", next)}
      />
      <AutomationField
        label="每日最多次数"
        type="number"
        value={value.maxRuns}
        onChange={(next) => set("maxRuns", next)}
      />
      <AutomationField
        label="每日金额上限（分）"
        type="number"
        value={value.maxAmountCents}
        onChange={(next) => set("maxAmountCents", next)}
      />
      <AutomationField
        label="设置原因"
        value={value.reason}
        onChange={(next) => set("reason", next)}
      />
    </div>
  );
}
