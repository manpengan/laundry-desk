import { z } from "zod";
import { CommandResponseSchema } from "../envelope/responses.js";

export const RemoteAssistanceCommandSchema = z.enum([
  "runtime.health",
  "runtime.version",
  "maintenance.summary",
]);
export const RemoteAssistanceStatusSchema = z.strictObject({
  configured: z.boolean(),
  state: z.enum(["unconfigured", "idle", "active", "revoked", "expired", "interrupted"]),
  session_id: z.uuid().nullable(),
  expires_at: z.number().int().safe().positive().nullable(),
  commands_completed: z.number().int().nonnegative().max(1000),
  allowed_commands: z.array(RemoteAssistanceCommandSchema).length(3),
});
export const RemoteAssistanceAuthorizeSchema = z.strictObject({
  password: z.string().min(1).max(1024),
  consent: z.literal(true),
});
export const DesktopRemoteAssistanceInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("status") }),
  z.strictObject({ operation: z.literal("authorize"), body: RemoteAssistanceAuthorizeSchema }),
  z.strictObject({
    operation: z.literal("revoke"),
    body: z.strictObject({ session_id: z.uuid() }),
  }),
]);
export const DesktopRemoteAssistanceResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), data: RemoteAssistanceStatusSchema }),
  CommandResponseSchema.options[1],
]);
export type RemoteAssistanceStatus = z.infer<typeof RemoteAssistanceStatusSchema>;
export type RemoteAssistanceAuthorize = z.infer<typeof RemoteAssistanceAuthorizeSchema>;
export type DesktopRemoteAssistanceInput = z.infer<typeof DesktopRemoteAssistanceInputSchema>;
export type RemoteAssistanceCommand = z.infer<typeof RemoteAssistanceCommandSchema>;
