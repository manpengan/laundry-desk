import { z } from "zod";

import { CommandErrorSchema } from "../envelope/responses.js";
import { SemVerSchema } from "../registry/primitives.js";
import {
  Base64UrlSignatureSchema,
  EdgeNonceSchema,
  ExactUtcTimestampSchema,
} from "./primitives.js";
import { OfflineGrantPayloadSchema, PrimaryLeasePayloadSchema } from "./protocols.js";

const EdgeSignatureSchema = Base64UrlSignatureSchema.length(86);
export const EdgeAuthorityChallengeSchema = Base64UrlSignatureSchema.length(43);
export const DevicePublicKeySpkiSchema = z
  .string()
  .min(40)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/u);
export const EdgePairingCodeSchema = z.string().regex(/^\d{6}$/u);

const signed = <T extends z.ZodType>(payload: T) =>
  z.strictObject({
    protocol_version: SemVerSchema,
    payload,
    sig: EdgeSignatureSchema,
  });

export const EdgeDeviceRegistrationPayloadSchema = z.strictObject({
  org_id: z.uuid(),
  store_id: z.uuid(),
  staff_id: z.uuid(),
  session_id: z.uuid(),
  session_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  permission_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  device_id: z.uuid(),
  device_public_key_spki: DevicePublicKeySpkiSchema,
  challenge_id: EdgeNonceSchema,
  challenge: EdgeAuthorityChallengeSchema,
  request_nonce: EdgeNonceSchema,
  request_primary: z.boolean(),
  pairing_code: EdgePairingCodeSchema.nullable(),
});
export const EdgeAuthorityChallengeRequestSchema = z.strictObject({
  request_nonce: EdgeNonceSchema,
  device_public_key_spki: DevicePublicKeySpkiSchema,
  request_primary: z.boolean(),
});
export const EdgeAuthorityChallengeDataSchema = z.strictObject({
  org_id: z.uuid(),
  store_id: z.uuid(),
  staff_id: z.uuid(),
  session_id: z.uuid(),
  session_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  permission_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  device_id: z.uuid(),
  challenge_id: EdgeNonceSchema,
  challenge: EdgeAuthorityChallengeSchema,
  request_nonce: EdgeNonceSchema,
  pairing_code: EdgePairingCodeSchema.nullable(),
  expires_at: ExactUtcTimestampSchema,
});
export const EdgeAuthorityChallengeResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), data: EdgeAuthorityChallengeDataSchema }),
  z.strictObject({ ok: z.literal(false), error: CommandErrorSchema }),
]);
export const EdgeAuthorityRequestSchema = signed(EdgeDeviceRegistrationPayloadSchema);
export const SignedOfflineGrantSchema = signed(OfflineGrantPayloadSchema);
export const SignedPrimaryLeaseSchema = signed(PrimaryLeasePayloadSchema);
export const EdgeAuthorityDataSchema = z.strictObject({
  server_public_key_spki: z.base64(),
  offline_grant: SignedOfflineGrantSchema,
  primary_lease: SignedPrimaryLeaseSchema.nullable(),
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

export type EdgeAuthorityChallengeData = DeepReadonly<
  z.output<typeof EdgeAuthorityChallengeDataSchema>
>;
export type EdgeAuthorityChallengeRequest = DeepReadonly<
  z.output<typeof EdgeAuthorityChallengeRequestSchema>
>;
export type EdgeAuthorityChallengeResponse = DeepReadonly<
  z.output<typeof EdgeAuthorityChallengeResponseSchema>
>;
export type EdgeAuthorityData = DeepReadonly<z.output<typeof EdgeAuthorityDataSchema>>;
export type EdgeAuthorityRequest = DeepReadonly<z.output<typeof EdgeAuthorityRequestSchema>>;
export type EdgeAuthorityResponse = DeepReadonly<z.output<typeof EdgeAuthorityResponseSchema>>;
