import { z } from "zod";

import { CommandErrorSchema } from "../envelope/responses.js";
import { OfflineGrantPayloadSchema, PrimaryLeasePayloadSchema } from "./protocols.js";

const ProtocolVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/u);
const EdgeSignatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/u);

const signed = <T extends z.ZodType>(payload: T) =>
  z.strictObject({
    protocol_version: ProtocolVersionSchema,
    payload,
    sig: EdgeSignatureSchema,
  });

export const EdgeAuthorityRequestSchema = z.strictObject({});
export const SignedOfflineGrantSchema = signed(OfflineGrantPayloadSchema);
export const SignedPrimaryLeaseSchema = signed(PrimaryLeasePayloadSchema);
export const EdgeAuthorityDataSchema = z.strictObject({
  server_public_key_spki: z.base64(),
  offline_grant: SignedOfflineGrantSchema,
  primary_lease: SignedPrimaryLeaseSchema,
});
export const EdgeAuthorityResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), data: EdgeAuthorityDataSchema }),
  z.strictObject({
    ok: z.literal(false),
    error: CommandErrorSchema,
  }),
]);

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type EdgeAuthorityData = DeepReadonly<z.output<typeof EdgeAuthorityDataSchema>>;
export type EdgeAuthorityResponse = DeepReadonly<z.output<typeof EdgeAuthorityResponseSchema>>;
