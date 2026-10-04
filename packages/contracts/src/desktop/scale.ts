import { z } from "zod";
import { CommandResponseSchema } from "../envelope/responses.js";

export const ScalePortNameSchema = z
  .string()
  .regex(/^COM(?:[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-6])$/u);
export const ScaleReadInputSchema = z.strictObject({
  operation: z.literal("read"),
  port: ScalePortNameSchema,
  baud: z.union([
    z.literal(1200),
    z.literal(2400),
    z.literal(4800),
    z.literal(9600),
    z.literal(19200),
    z.literal(38400),
  ]),
  framing: z.enum(["8N1", "7E1", "7O1"]),
});
export const DesktopScaleInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("ports") }),
  ScaleReadInputSchema,
]);
export const ScaleReadingSchema = z.strictObject({
  grams: z.number().int().min(1).max(1000000),
  basis: z.enum(["weight", "gross", "net"]),
  port: ScalePortNameSchema,
  captured_at: z.number().int().safe().positive(),
  protocol: z.literal("and-standard-ascii-v1"),
});
export const ScalePortsSchema = z.strictObject({ ports: z.array(ScalePortNameSchema).max(256) });
export const DesktopScaleResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), data: z.union([ScaleReadingSchema, ScalePortsSchema]) }),
  CommandResponseSchema.options[1],
]);
export type DesktopScaleInput = z.infer<typeof DesktopScaleInputSchema>;
export type ScaleReadInput = z.infer<typeof ScaleReadInputSchema>;
export type ScaleReading = z.infer<typeof ScaleReadingSchema>;
