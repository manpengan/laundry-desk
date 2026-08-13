import type { z } from "zod";

type DesktopOperationSchema = Readonly<{ input: z.ZodType; result: z.ZodType }>;
type DesktopOperationNamespace<TName extends string> = Readonly<
  Record<TName, DesktopOperationSchema>
>;

export type DesktopOperationSchemas = Readonly<{
  auth: DesktopOperationNamespace<"login" | "refresh" | "pinChallenge" | "pinVerify" | "logout">;
  command: DesktopOperationNamespace<"execute">;
  query: DesktopOperationNamespace<"execute">;
  photo: DesktopOperationNamespace<"upload" | "read" | "delete">;
  offline: DesktopOperationNamespace<"resume" | "status" | "resolve">;
  health: DesktopOperationNamespace<"get">;
}>;
