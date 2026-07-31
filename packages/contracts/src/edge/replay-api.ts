import { z } from "zod";

import { CommandErrorSchema, CommandResponseSchema } from "../envelope/responses.js";
import { SemVerSchema } from "../registry/primitives.js";
import {
  DevicePublicKeySpkiSchema,
  EdgeAuthorityChallengeSchema,
  EdgePairingCodeSchema,
} from "./authority-api.js";
import { Base64UrlSignatureSchema, EdgeNonceSchema } from "./primitives.js";
import { EdgeQueueEnvelopeSchema } from "./queue-envelope.js";
import type { EdgeQueueEnvelope } from "./queue-envelope.js";

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type EdgeDeviceRegistrationAuthority = Readonly<{
  protocol_version: string;
  payload: Readonly<{
    org_id: string;
    store_id: string;
    staff_id: string;
    session_id: string;
    session_version: number;
    permission_version: number;
    device_id: string;
    device_public_key_spki: string;
    challenge_id: string;
    challenge: string;
    request_nonce: string;
    request_primary: boolean;
    pairing_code: string | null;
  }>;
}>;
export type EdgeReplayAuthority = Readonly<{
  protocol_version: string;
  payload: Readonly<{
    device_id: string;
    envelope: EdgeQueueEnvelope;
  }>;
}>;
export type EdgeReplayRequest = Readonly<EdgeReplayAuthority & { sig: string }>;

export const EdgeDeviceRegistrationAuthoritySchema: z.ZodType<EdgeDeviceRegistrationAuthority> =
  z.strictObject({
    protocol_version: SemVerSchema,
    payload: z.strictObject({
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
    }),
  });

export const EdgeReplayAuthoritySchema: z.ZodType<EdgeReplayAuthority> = z.strictObject({
  protocol_version: SemVerSchema,
  payload: z.strictObject({
    device_id: z.uuid(),
    envelope: EdgeQueueEnvelopeSchema,
  }),
});

export const EdgeReplayRequestSchema: z.ZodType<EdgeReplayRequest> = z.strictObject({
  protocol_version: SemVerSchema,
  payload: z.strictObject({
    device_id: z.uuid(),
    envelope: EdgeQueueEnvelopeSchema,
  }),
  sig: Base64UrlSignatureSchema,
});

export const EdgeReplayDispositionSchema = z.enum(["applied", "duplicate"]);
export const EdgeReplayResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    data: z.strictObject({
      disposition: EdgeReplayDispositionSchema,
      command: CommandResponseSchema,
    }),
  }),
  z.strictObject({ ok: z.literal(false), error: CommandErrorSchema }),
]);

export type EdgeReplayResponse = DeepReadonly<z.output<typeof EdgeReplayResponseSchema>>;
