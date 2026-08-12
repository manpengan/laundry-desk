import { randomUUID } from "node:crypto";

import {
  DeliveryAppointmentCancelInputSchema,
  DeliveryAppointmentAddressesListInputSchema,
  DeliveryAppointmentAddressesListResultSchema,
  DeliveryAppointmentCreateInputSchema,
  DeliveryAppointmentGetInputSchema,
  DeliveryAppointmentGetResultSchema,
  DeliveryAppointmentMutationResultSchema,
  DeliveryAppointmentRescheduleInputSchema,
  DeliveryAppointmentsListInputSchema,
  DeliveryAppointmentsListResultSchema,
  createCommandError,
  type DeliveryAppointment,
} from "@laundry/contracts";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import type { DeliveryPolicyStore } from "../delivery-policy/types.js";
import { evaluateDeliveryAvailability } from "../delivery-policy/quote.js";
import type { DeliveryAppointmentStore } from "./types.js";
import type { DeliveryAddressResolver } from "./address-resolver.js";

export type DeliveryAppointmentHandlerDeps = Readonly<{
  store: DeliveryAppointmentStore;
  policy: DeliveryPolicyStore;
  addresses: DeliveryAddressResolver;
  featureEnabled: (client: SqlClient, tenant: TenantContext) => Promise<boolean>;
  timeZone: (client: SqlClient, tenant: TenantContext) => Promise<string>;
  now?: () => number;
  newId?: () => string;
}>;

function invariantFailed(): never {
  throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
}

function unavailable(): never {
  throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
}

function auditView(appointment: DeliveryAppointment): Readonly<Record<string, unknown>> {
  return Object.freeze({
    appointment_id: appointment.appointment_id,
    direction: appointment.direction,
    service_area_code: appointment.service_area_code,
    scheduled_start_at: appointment.scheduled_start_at,
    scheduled_end_at: appointment.scheduled_end_at,
    fee_cents: appointment.fee_cents,
    status: appointment.status,
    version: appointment.version,
    policy_version: appointment.policy_version,
    cancellation_reason: appointment.cancellation_reason,
  });
}

async function availableQuote(
  deps: DeliveryAppointmentHandlerDeps,
  context: Parameters<CommandHandler>[0],
  request: Readonly<{
    direction: DeliveryAppointment["direction"];
    service_area_code: string;
    requested_start_at: number;
    expected_policy_version: number;
  }>,
  now: number,
) {
  const policy = await deps.policy.get(context.tenant.orgId, context.tenant.storeId);
  if (policy.version !== request.expected_policy_version) invariantFailed();
  const [featureEnabled, timezone] = await Promise.all([
    deps.featureEnabled(context.client, context.tenant),
    deps.timeZone(context.client, context.tenant),
  ]);
  const quote = evaluateDeliveryAvailability({
    request,
    policy,
    featureEnabled,
    timezone,
    nowEpochSeconds: now,
  });
  if (
    !quote.can_request_appointment ||
    quote.requested_end_at === null ||
    quote.fee_cents === null ||
    quote.max_appointments_per_slot === null
  ) {
    invariantFailed();
  }
  const availableQuote = Object.freeze({
    ...quote,
    requested_end_at: quote.requested_end_at,
    fee_cents: quote.fee_cents,
    max_appointments_per_slot: quote.max_appointments_per_slot,
  });
  return Object.freeze({ quote: availableQuote, policy });
}

async function activeAddress(
  deps: DeliveryAppointmentHandlerDeps,
  context: Parameters<CommandHandler>[0],
  customerId: string,
  addressId: string,
) {
  const address = await deps.addresses.resolve(
    context.client,
    context.tenant,
    customerId,
    addressId,
  );
  if (address === null) invariantFailed();
  return address;
}

function mutationOutcome(
  appointment: DeliveryAppointment,
  before: DeliveryAppointment | null,
  eventType: string,
): HandlerOutcome {
  return Object.freeze({
    result: DeliveryAppointmentMutationResultSchema.parse({ appointment }),
    privacySubjectCustomerId: appointment.customer_id,
    audit: Object.freeze({
      entity: "delivery_appointment",
      entityId: appointment.appointment_id,
      ...(before === null ? {} : { beforeJson: JSON.stringify(auditView(before)) }),
      afterJson: JSON.stringify(auditView(appointment)),
    }),
    events: Object.freeze([
      Object.freeze({
        type: eventType,
        payload: Object.freeze({
          appointment_id: appointment.appointment_id,
          customer_id: appointment.customer_id,
          version: appointment.version,
        }),
      }),
    ]),
  });
}

function createHandler(deps: DeliveryAppointmentHandlerDeps): CommandHandler {
  return async (context) => {
    const input = DeliveryAppointmentCreateInputSchema.parse(context.parsed);
    const now = deps.now?.() ?? Math.floor(Date.now() / 1_000);
    const address = await activeAddress(deps, context, input.customer_id, input.address_id);
    const { quote } = await availableQuote(deps, context, input, now);
    const result = await deps.store.create({
      appointment_id: deps.newId?.() ?? randomUUID(),
      org_id: context.tenant.orgId,
      store_id: context.tenant.storeId,
      staff_id: context.actor.staffId,
      customer_id: address.customer_id,
      address_id: input.address_id,
      direction: input.direction,
      service_area_code: input.service_area_code,
      scheduled_start_at: input.requested_start_at,
      scheduled_end_at: quote.requested_end_at,
      fee_cents: quote.fee_cents,
      policy_version: quote.policy_version,
      timezone: quote.timezone,
      max_appointments_per_slot: quote.max_appointments_per_slot,
      at: now,
    });
    if (!result.ok) invariantFailed();
    return mutationOutcome(result.appointment, null, "delivery.appointment.created");
  };
}

function rescheduleHandler(deps: DeliveryAppointmentHandlerDeps): CommandHandler {
  return async (context) => {
    const input = DeliveryAppointmentRescheduleInputSchema.parse(context.parsed);
    const current = await deps.store.get(
      context.tenant.orgId,
      context.tenant.storeId,
      input.appointment_id,
    );
    if (
      current === null ||
      current.customer_id !== input.customer_id ||
      current.version !== input.expected_version ||
      current.status !== "scheduled"
    ) {
      invariantFailed();
    }
    await activeAddress(deps, context, current.customer_id, current.address_id);
    const now = deps.now?.() ?? Math.floor(Date.now() / 1_000);
    const { quote } = await availableQuote(
      deps,
      context,
      {
        direction: current.direction,
        service_area_code: current.service_area_code,
        requested_start_at: input.requested_start_at,
        expected_policy_version: input.expected_policy_version,
      },
      now,
    );
    const result = await deps.store.reschedule({
      org_id: context.tenant.orgId,
      store_id: context.tenant.storeId,
      staff_id: context.actor.staffId,
      appointment_id: current.appointment_id,
      customer_id: current.customer_id,
      expected_version: current.version,
      direction: current.direction,
      service_area_code: current.service_area_code,
      scheduled_start_at: input.requested_start_at,
      scheduled_end_at: quote.requested_end_at,
      fee_cents: quote.fee_cents,
      policy_version: quote.policy_version,
      timezone: quote.timezone,
      max_appointments_per_slot: quote.max_appointments_per_slot,
      at: now,
    });
    if (!result.ok) invariantFailed();
    return mutationOutcome(result.appointment, current, "delivery.appointment.rescheduled");
  };
}

function cancelHandler(deps: DeliveryAppointmentHandlerDeps): CommandHandler {
  return async (context) => {
    const input = DeliveryAppointmentCancelInputSchema.parse(context.parsed);
    const current = await deps.store.get(
      context.tenant.orgId,
      context.tenant.storeId,
      input.appointment_id,
    );
    if (current === null || current.customer_id !== input.customer_id) invariantFailed();
    const result = await deps.store.cancel({
      org_id: context.tenant.orgId,
      store_id: context.tenant.storeId,
      staff_id: context.actor.staffId,
      ...input,
      at: deps.now?.() ?? Math.floor(Date.now() / 1_000),
    });
    if (!result.ok) invariantFailed();
    return mutationOutcome(result.appointment, current, "delivery.appointment.cancelled");
  };
}

export function registerDeliveryAppointmentCommandHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: DeliveryAppointmentHandlerDeps,
): void {
  registry.registerHandler("delivery.appointment.create", createHandler(deps));
  registry.registerHandler("delivery.appointment.reschedule", rescheduleHandler(deps));
  registry.registerHandler("delivery.appointment.cancel", cancelHandler(deps));
}

export function registerDeliveryAppointmentQueryHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: DeliveryAppointmentHandlerDeps,
): void {
  registry.registerHandler("delivery.appointment.get", async (context) => {
    const input = DeliveryAppointmentGetInputSchema.parse(context.parsed);
    const appointment = await deps.store.get(
      context.tenant.orgId,
      context.tenant.storeId,
      input.appointment_id,
    );
    if (appointment === null) unavailable();
    return Object.freeze({ result: DeliveryAppointmentGetResultSchema.parse({ appointment }) });
  });
  registry.registerHandler("delivery.appointment.addresses.list", async (context) => {
    const input = DeliveryAppointmentAddressesListInputSchema.parse(context.parsed);
    const result = await deps.addresses.list(context.client, context.tenant, input.customer_id);
    if (result === null) unavailable();
    return Object.freeze({ result: DeliveryAppointmentAddressesListResultSchema.parse(result) });
  });
  registry.registerHandler("delivery.appointments.list", async (context) => {
    const parsed = DeliveryAppointmentsListInputSchema.parse(context.parsed);
    const input = Object.freeze({ ...parsed, limit: parsed.limit ?? 50 });
    const appointments = await deps.store.list(context.tenant.orgId, context.tenant.storeId, input);
    return Object.freeze({
      result: DeliveryAppointmentsListResultSchema.parse({ appointments }),
    });
  });
}
