import type { DeliveryPolicyConfirmationSummary } from "@laundry/contracts";
import { MoneyText } from "@laundry/ui";

import { DELIVERY_WEEKDAYS } from "./delivery-policy-model.js";

const WEEKDAY = new Map<number, string>(
  DELIVERY_WEEKDAYS.map((value) => [value.value, value.label]),
);

function timeLabel(minutes: number): string {
  if (minutes === 1_440) return "24:00";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function DeliveryPolicyConfirmationSummaryView({
  summary,
}: Readonly<{ summary: DeliveryPolicyConfirmationSummary }>) {
  return (
    <div className="ld-delivery-policy__confirmation" data-testid="delivery-policy-confirmation">
      <p>
        当前版本 {summary.expected_version} → {summary.expected_version + 1}；
        {summary.accepting_appointments ? "允许预约" : "暂停预约"}
      </p>
      <p>
        提前 {summary.minimum_lead_minutes} 分钟至 {summary.maximum_advance_days} 天；每格{" "}
        {summary.slot_minutes} 分钟、最多 {summary.max_appointments_per_slot} 单。
      </p>
      <ul>
        {summary.service_areas.map((area) => (
          <li key={area.code}>
            {area.code} · {area.name} · <MoneyText fen={area.fee_cents} /> ·{" "}
            {area.is_active ? "启用" : "停用"}
          </li>
        ))}
      </ul>
      <ul>
        {summary.weekly_windows.map((window) => (
          <li key={`${window.weekday}:${window.start_minute}`}>
            {WEEKDAY.get(window.weekday) ?? `星期 ${window.weekday}`} ·{" "}
            {timeLabel(window.start_minute)}–{timeLabel(window.end_minute)}
          </li>
        ))}
      </ul>
    </div>
  );
}
