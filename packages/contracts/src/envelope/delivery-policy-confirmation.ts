import { z } from "zod";

import {
  DeliveryServiceAreaSchema,
  DeliveryWeeklyWindowSchema,
} from "../commands/delivery-policy.js";

export const DeliveryPolicyConfirmationSummarySchema = z
  .object({
    kind: z.literal("delivery_policy"),
    expected_version: z.number().int().nonnegative().max(2_147_483_646),
    accepting_appointments: z.boolean(),
    minimum_lead_minutes: z.number().int().nonnegative().max(10_080),
    maximum_advance_days: z.number().int().positive().max(365),
    slot_minutes: z.number().int().min(15).max(240),
    max_appointments_per_slot: z.number().int().positive().max(100),
    service_areas: z.array(DeliveryServiceAreaSchema).max(20),
    weekly_windows: z.array(DeliveryWeeklyWindowSchema).max(28),
  })
  .strict();

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type DeliveryPolicyConfirmationSummary = DeepReadonly<
  z.output<typeof DeliveryPolicyConfirmationSummarySchema>
>;
