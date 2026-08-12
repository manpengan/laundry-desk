import { z } from "zod";

export const PickupReminderAgeDaysSchema = z.union([z.literal(30), z.literal(90), z.literal(180)]);
export const PickupReminderGarmentStatusSchema = z.enum(["ready", "racked"]);

export const PickupReminderStatusesSchema = z
  .array(PickupReminderGarmentStatusSchema)
  .min(1)
  .max(2)
  .refine((statuses) => new Set(statuses).size === statuses.length, {
    message: "Garment statuses must be unique",
  });
