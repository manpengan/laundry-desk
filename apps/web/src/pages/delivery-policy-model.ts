import {
  DeliveryAvailabilityQuoteResultSchema,
  DeliveryPolicySchema,
  DeliveryPolicySetInputSchema,
  type DeliveryAvailabilityQuote,
  type DeliveryPolicySetInput,
} from "@laundry/contracts";

export type DeliveryAreaDraft = Readonly<{
  row_id: string;
  code: string;
  name: string;
  fee_text: string;
  is_active: boolean;
}>;

export type DeliveryWindowDraft = Readonly<{
  row_id: string;
  weekday: number;
  start_text: string;
  end_text: string;
}>;

export type DeliveryPolicyDraft = Readonly<{
  version: number;
  accepting_appointments: boolean;
  minimum_lead_text: string;
  maximum_advance_text: string;
  slot_text: string;
  capacity_text: string;
  service_areas: readonly DeliveryAreaDraft[];
  weekly_windows: readonly DeliveryWindowDraft[];
}>;

export const EMPTY_DELIVERY_POLICY_DRAFT: DeliveryPolicyDraft = Object.freeze({
  version: 0,
  accepting_appointments: false,
  minimum_lead_text: "120",
  maximum_advance_text: "14",
  slot_text: "60",
  capacity_text: "1",
  service_areas: Object.freeze([]),
  weekly_windows: Object.freeze([]),
});

export const DELIVERY_WEEKDAYS = Object.freeze([
  Object.freeze({ value: 1, label: "周一" }),
  Object.freeze({ value: 2, label: "周二" }),
  Object.freeze({ value: 3, label: "周三" }),
  Object.freeze({ value: 4, label: "周四" }),
  Object.freeze({ value: 5, label: "周五" }),
  Object.freeze({ value: 6, label: "周六" }),
  Object.freeze({ value: 7, label: "周日" }),
]);

const digits = (value: string): number | null => {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const minuteFromText = (value: string, allowDayEnd: boolean): number | null => {
  if (allowDayEnd && value === "24:00") return 1_440;
  const match = /^(\d{2}):(\d{2})$/u.exec(value.trim());
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? hour * 60 + minute : null;
};

const textFromMinute = (minute: number): string => {
  if (minute === 1_440) return "24:00";
  return `${Math.floor(minute / 60)
    .toString()
    .padStart(2, "0")}:${(minute % 60).toString().padStart(2, "0")}`;
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapBusResult(value: unknown): unknown {
  return isRecord(value) && "result" in value ? value.result : value;
}

export function readDeliveryPolicy(value: unknown): DeliveryPolicyDraft | null {
  const result = unwrapBusResult(value);
  if (!isRecord(result)) return null;
  const parsed = DeliveryPolicySchema.safeParse(result.policy);
  if (!parsed.success) return null;
  return Object.freeze({
    version: parsed.data.version,
    accepting_appointments: parsed.data.accepting_appointments,
    minimum_lead_text: String(parsed.data.minimum_lead_minutes),
    maximum_advance_text: String(parsed.data.maximum_advance_days),
    slot_text: String(parsed.data.slot_minutes),
    capacity_text: String(parsed.data.max_appointments_per_slot),
    service_areas: Object.freeze(
      parsed.data.service_areas.map((area, index) =>
        Object.freeze({
          row_id: `area-${index}-${area.code}`,
          code: area.code,
          name: area.name,
          fee_text: String(area.fee_cents),
          is_active: area.is_active,
        }),
      ),
    ),
    weekly_windows: Object.freeze(
      parsed.data.weekly_windows.map((window, index) =>
        Object.freeze({
          row_id: `window-${index}-${window.weekday}-${window.start_minute}`,
          weekday: window.weekday,
          start_text: textFromMinute(window.start_minute),
          end_text: textFromMinute(window.end_minute),
        }),
      ),
    ),
  });
}

function validateSchedule(input: DeliveryPolicySetInput): string | null {
  const ordered = [...input.weekly_windows].sort(
    (left, right) => left.weekday - right.weekday || left.start_minute - right.start_minute,
  );
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    if (current === undefined) continue;
    const duration = current.end_minute - current.start_minute;
    if (duration < input.slot_minutes || duration % input.slot_minutes !== 0) {
      return "每个服务时段必须由完整预约格组成";
    }
    const previous = ordered[index - 1];
    if (
      previous !== undefined &&
      previous.weekday === current.weekday &&
      current.start_minute < previous.end_minute
    ) {
      return "同一天的服务时段不能重叠";
    }
  }
  if (
    input.accepting_appointments &&
    (!input.service_areas.some(({ is_active }) => is_active) || input.weekly_windows.length === 0)
  ) {
    return "开放预约前至少需要一个启用区域和一个服务时段";
  }
  return null;
}

export function buildDeliveryPolicyInput(
  draft: DeliveryPolicyDraft,
): Readonly<{ ok: true; body: DeliveryPolicySetInput }> | Readonly<{ ok: false; message: string }> {
  const serviceAreas = draft.service_areas.map((area) => ({
    code: area.code.trim(),
    name: area.name.trim(),
    fee_cents: digits(area.fee_text),
    is_active: area.is_active,
  }));
  const weeklyWindows = draft.weekly_windows.map((window) => ({
    weekday: window.weekday,
    start_minute: minuteFromText(window.start_text, false),
    end_minute: minuteFromText(window.end_text, true),
  }));
  const candidate = {
    expected_version: draft.version,
    accepting_appointments: draft.accepting_appointments,
    minimum_lead_minutes: digits(draft.minimum_lead_text),
    maximum_advance_days: digits(draft.maximum_advance_text),
    slot_minutes: digits(draft.slot_text),
    max_appointments_per_slot: digits(draft.capacity_text),
    service_areas: serviceAreas,
    weekly_windows: weeklyWindows,
  };
  const parsed = DeliveryPolicySetInputSchema.safeParse(candidate);
  if (!parsed.success) {
    return Object.freeze({ ok: false as const, message: "请检查区域、金额、时段和预约规则" });
  }
  const scheduleError = validateSchedule(parsed.data);
  if (scheduleError !== null) return Object.freeze({ ok: false as const, message: scheduleError });
  const frozenServiceAreas = parsed.data.service_areas.map((area) => Object.freeze({ ...area }));
  const frozenWeeklyWindows = parsed.data.weekly_windows.map((window) =>
    Object.freeze({ ...window }),
  );
  Object.freeze(frozenServiceAreas);
  Object.freeze(frozenWeeklyWindows);
  const body: DeliveryPolicySetInput = {
    ...parsed.data,
    service_areas: frozenServiceAreas,
    weekly_windows: frozenWeeklyWindows,
  };
  return Object.freeze({
    ok: true as const,
    body: Object.freeze(body),
  });
}

export function readDeliveryQuote(value: unknown): DeliveryAvailabilityQuote | null {
  const parsed = DeliveryAvailabilityQuoteResultSchema.safeParse(unwrapBusResult(value));
  return parsed.success ? Object.freeze(parsed.data.quote) : null;
}

export function epochFromLocalDateTime(value: string): number | null {
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  const seconds = Math.floor(milliseconds / 1_000);
  return Number.isSafeInteger(seconds) && seconds % 60 === 0 ? seconds : null;
}
