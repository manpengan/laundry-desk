import {
  DeliveryAvailabilityQuoteSchema,
  type DeliveryAvailabilityQuote,
  type DeliveryAvailabilityQuoteInput,
} from "@laundry/contracts";

import type { StoreDeliveryPolicy } from "./types.js";

export type DeliveryQuoteEvaluationInput = Readonly<{
  request: DeliveryAvailabilityQuoteInput;
  policy: StoreDeliveryPolicy;
  featureEnabled: boolean;
  timezone: string;
  nowEpochSeconds: number;
}>;

type LocalTime = Readonly<{ weekday: number; minute: number; second: number }>;

const WEEKDAY_BY_LABEL: Readonly<Record<string, number>> = Object.freeze({
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
});

function localTimeAt(epochSeconds: number, timezone: string): LocalTime {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(epochSeconds * 1_000))
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
  const weekday = WEEKDAY_BY_LABEL[parts.weekday ?? ""];
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  if (
    weekday === undefined ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second)
  ) {
    throw new TypeError("Unable to derive local delivery quote time");
  }
  return Object.freeze({ weekday, minute: hour * 60 + minute, second });
}

function unavailable(
  input: DeliveryQuoteEvaluationInput,
  reason: Exclude<DeliveryAvailabilityQuote["reason"], "available">,
): DeliveryAvailabilityQuote {
  return Object.freeze(
    DeliveryAvailabilityQuoteSchema.parse({
      policy_version: input.policy.version,
      feature_enabled: input.featureEnabled,
      can_request_appointment: false,
      reason,
      direction: input.request.direction,
      service_area_code: input.request.service_area_code,
      requested_start_at: input.request.requested_start_at,
      requested_end_at: null,
      fee_cents: null,
      capacity_status: "not_checked",
      max_appointments_per_slot: null,
      timezone: input.timezone,
    }),
  );
}

export function evaluateDeliveryAvailability(
  input: DeliveryQuoteEvaluationInput,
): DeliveryAvailabilityQuote {
  if (!input.featureEnabled) return unavailable(input, "delivery_disabled");
  if (input.policy.version === 0) return unavailable(input, "policy_not_configured");
  if (!input.policy.accepting_appointments) return unavailable(input, "appointments_paused");

  const area = input.policy.service_areas.find(
    ({ code, is_active }) => code === input.request.service_area_code && is_active,
  );
  if (area === undefined) return unavailable(input, "service_area_unavailable");

  const earliest = input.nowEpochSeconds + input.policy.minimum_lead_minutes * 60;
  const latest = input.nowEpochSeconds + input.policy.maximum_advance_days * 86_400;
  if (input.request.requested_start_at < earliest || input.request.requested_start_at > latest) {
    return unavailable(input, "outside_booking_horizon");
  }

  const local = localTimeAt(input.request.requested_start_at, input.timezone);
  const window = input.policy.weekly_windows.find(
    ({ weekday, start_minute, end_minute }) =>
      weekday === local.weekday && local.minute >= start_minute && local.minute < end_minute,
  );
  if (window === undefined) return unavailable(input, "outside_service_window");

  const slotEndMinute = local.minute + input.policy.slot_minutes;
  if (
    local.second !== 0 ||
    (local.minute - window.start_minute) % input.policy.slot_minutes !== 0 ||
    slotEndMinute > window.end_minute
  ) {
    return unavailable(input, "slot_misaligned");
  }

  return Object.freeze(
    DeliveryAvailabilityQuoteSchema.parse({
      policy_version: input.policy.version,
      feature_enabled: true,
      can_request_appointment: true,
      reason: "available",
      direction: input.request.direction,
      service_area_code: input.request.service_area_code,
      requested_start_at: input.request.requested_start_at,
      requested_end_at: input.request.requested_start_at + input.policy.slot_minutes * 60,
      fee_cents: area.fee_cents,
      capacity_status: "not_checked",
      max_appointments_per_slot: input.policy.max_appointments_per_slot,
      timezone: input.timezone,
    }),
  );
}
