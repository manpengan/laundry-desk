import {
  DeliveryPolicySchema,
  DeliveryServiceAreaSchema,
  DeliveryWeeklyWindowSchema,
  type DeliveryServiceArea,
  type DeliveryWeeklyWindow,
} from "@laundry/contracts";

export type StoreDeliveryPolicy = Readonly<{
  version: number;
  accepting_appointments: boolean;
  minimum_lead_minutes: number;
  maximum_advance_days: number;
  slot_minutes: number;
  max_appointments_per_slot: number;
  service_areas: readonly Readonly<DeliveryServiceArea>[];
  weekly_windows: readonly Readonly<DeliveryWeeklyWindow>[];
  updated_at: number | null;
}>;

export type DeliveryPolicySetRequest = Readonly<{
  org_id: string;
  store_id: string;
  staff_id: string;
  expected_version: number;
  accepting_appointments: boolean;
  minimum_lead_minutes: number;
  maximum_advance_days: number;
  slot_minutes: number;
  max_appointments_per_slot: number;
  service_areas: readonly Readonly<DeliveryServiceArea>[];
  weekly_windows: readonly Readonly<DeliveryWeeklyWindow>[];
  updated_at: number;
}>;

export type DeliveryPolicyChange = Readonly<{
  before: StoreDeliveryPolicy;
  after: StoreDeliveryPolicy;
}>;

export type DeliveryPolicyStore = Readonly<{
  get: (orgId: string, storeId: string) => Promise<StoreDeliveryPolicy>;
  /** Null means expected_version no longer matches the current projection. */
  set: (request: DeliveryPolicySetRequest) => Promise<DeliveryPolicyChange | null>;
}>;

export const EMPTY_DELIVERY_POLICY: StoreDeliveryPolicy = Object.freeze({
  version: 0,
  accepting_appointments: false,
  minimum_lead_minutes: 120,
  maximum_advance_days: 14,
  slot_minutes: 60,
  max_appointments_per_slot: 1,
  service_areas: Object.freeze([]),
  weekly_windows: Object.freeze([]),
  updated_at: null,
});

function normalizeServiceAreas(value: unknown): StoreDeliveryPolicy["service_areas"] {
  const parsed = DeliveryServiceAreaSchema.array().max(20).safeParse(value);
  if (!parsed.success) throw new TypeError("Invalid persisted delivery service areas");
  const codes = new Set<string>();
  for (const area of parsed.data) {
    if (codes.has(area.code)) throw new TypeError("Duplicate delivery service area code");
    codes.add(area.code);
  }
  return Object.freeze(
    parsed.data
      .map((area) => Object.freeze({ ...area }))
      .sort((left, right) => left.code.localeCompare(right.code)),
  );
}

function normalizeWindows(
  value: unknown,
  slotMinutes: number,
): StoreDeliveryPolicy["weekly_windows"] {
  const parsed = DeliveryWeeklyWindowSchema.array().max(28).safeParse(value);
  if (!parsed.success) throw new TypeError("Invalid persisted delivery weekly windows");
  const ordered = parsed.data
    .map((window) => Object.freeze({ ...window }))
    .sort((left, right) => left.weekday - right.weekday || left.start_minute - right.start_minute);
  let previous: Readonly<DeliveryWeeklyWindow> | undefined;
  for (const window of ordered) {
    const duration = window.end_minute - window.start_minute;
    if (duration < slotMinutes || duration % slotMinutes !== 0) {
      throw new TypeError("Delivery window must contain whole appointment slots");
    }
    if (
      previous !== undefined &&
      previous.weekday === window.weekday &&
      window.start_minute < previous.end_minute
    ) {
      throw new TypeError("Delivery weekly windows cannot overlap");
    }
    previous = window;
  }
  return Object.freeze(ordered);
}

export function freezeDeliveryPolicy(input: StoreDeliveryPolicy): StoreDeliveryPolicy {
  const parsed = DeliveryPolicySchema.safeParse(input);
  if (!parsed.success) throw new TypeError("Invalid persisted delivery policy");
  const serviceAreas = normalizeServiceAreas(parsed.data.service_areas);
  const weeklyWindows = normalizeWindows(parsed.data.weekly_windows, parsed.data.slot_minutes);
  if (
    parsed.data.accepting_appointments &&
    (!serviceAreas.some(({ is_active }) => is_active) || weeklyWindows.length === 0)
  ) {
    throw new TypeError("An accepting delivery policy needs an active area and service window");
  }
  return Object.freeze({
    ...parsed.data,
    service_areas: serviceAreas,
    weekly_windows: weeklyWindows,
  });
}

export function policyFromSetRequest(
  request: DeliveryPolicySetRequest,
  version: number,
): StoreDeliveryPolicy {
  return freezeDeliveryPolicy({
    version,
    accepting_appointments: request.accepting_appointments,
    minimum_lead_minutes: request.minimum_lead_minutes,
    maximum_advance_days: request.maximum_advance_days,
    slot_minutes: request.slot_minutes,
    max_appointments_per_slot: request.max_appointments_per_slot,
    service_areas: request.service_areas,
    weekly_windows: request.weekly_windows,
    updated_at: request.updated_at,
  });
}
