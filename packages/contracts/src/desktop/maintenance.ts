import { z } from "zod";
import { CommandResponseSchema } from "../envelope/responses.js";
const Timestamp = z.iso.datetime().nullable();
export const MaintenanceIntentSchema = z.enum([
  "maintenance",
  "backup",
  "drill",
  "export-store",
  "v1-import",
]);
export const DesktopMaintenanceInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("health") }),
  z.strictObject({
    operation: z.literal("open"),
    intent: z.enum(["maintenance", "backup", "drill"]),
  }),
  z.strictObject({
    operation: z.literal("handoff"),
    intent: z.enum(["export-store", "v1-import"]),
    request_id: z.uuid(),
  }),
]);
export const MaintenanceHealthSchema = z.strictObject({
  status: z.literal("backup_health"),
  checked_at: z.iso.datetime(),
  enabled: z.boolean(),
  last_backup_at: Timestamp,
  last_drill_at: Timestamp,
  last_offsite_at: Timestamp,
  next_backup_at: Timestamp,
  free_mib: z.number().int().nonnegative().safe(),
  latest: z
    .strictObject({
      at: z.iso.datetime(),
      status: z.enum(["started", "succeeded", "failed"]),
      code: z
        .string()
        .regex(/^WINDOWS_COMPANION_[A-Z_]{1,80}$/u)
        .nullable(),
    })
    .nullable(),
  alerts: z
    .array(
      z.enum([
        "low_space",
        "interrupted",
        "last_run_failed",
        "backup_overdue",
        "drill_overdue",
        "task_missing",
        "task_unavailable",
        "offsite_overdue",
        "backup_disabled",
      ]),
    )
    .max(9),
});
export const MaintenanceOpenedSchema = z.strictObject({ status: z.literal("maintenance_opened") });
export const DesktopMaintenanceResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    data: z.union([MaintenanceHealthSchema, MaintenanceOpenedSchema]),
  }),
  CommandResponseSchema.options[1],
]);
export type DesktopMaintenanceInput = z.infer<typeof DesktopMaintenanceInputSchema>;
export type MaintenanceHealth = z.infer<typeof MaintenanceHealthSchema>;
export type MaintenanceIntent = z.infer<typeof MaintenanceIntentSchema>;
