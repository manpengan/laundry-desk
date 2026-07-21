import { z } from "zod";

import { parseEdgeQueueEnvelope } from "../edge/queue-envelope.js";
import type { EdgeQueueEnvelope } from "../edge/queue-envelope.js";
import { CommandNameSchema } from "../registry/primitives.js";
import { snapshotExactPlainObject } from "./plain-data.js";
import { registerEdgeReplaySource } from "./source-registry.js";
import type { AuthenticatedActor, AuthenticatedTenant } from "./session.js";

const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const UniqueCommandsSchema = z
  .array(CommandNameSchema)
  .min(1)
  .refine((commands) => new Set(commands).size === commands.length, {
    message: "Verified authorization command names must be unique",
  });
const UniquePrimaryLeaseCommandsSchema = z
  .array(CommandNameSchema)
  .refine((commands) => new Set(commands).size === commands.length, {
    message: "Verified Primary lease command names must be unique",
  });

const GrantAuthorizationSchema = z.strictObject({
  kind: z.literal("grant"),
  grant_id: z.uuid(),
  allowed_commands: UniqueCommandsSchema,
  primary_lease_commands: UniquePrimaryLeaseCommandsSchema,
});

const PrimaryLeaseAuthorizationSchema = z.strictObject({
  kind: z.literal("primary_lease"),
  grant_id: z.uuid(),
  lease_id: z.uuid(),
  primary_epoch: PositiveSafeIntegerSchema,
  allowed_commands: UniqueCommandsSchema,
  primary_lease_commands: UniquePrimaryLeaseCommandsSchema,
});

const VerifiedEdgeAuthorizationSchema = z
  .discriminatedUnion("kind", [GrantAuthorizationSchema, PrimaryLeaseAuthorizationSchema])
  .refine(
    (authorization) =>
      authorization.primary_lease_commands.every((command) =>
        authorization.allowed_commands.includes(command),
      ),
    { message: "Primary lease commands must be a subset of allowed commands" },
  );

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type VerifiedEdgeAuthorization = DeepReadonly<
  z.output<typeof VerifiedEdgeAuthorizationSchema>
>;

declare const EDGE_REPLAY_SOURCE_BRAND: unique symbol;

export type EdgeReplaySource = Readonly<{
  kind: "edge_replay";
  device_session_id: string;
  permission_version: number;
  actor: Readonly<AuthenticatedActor & { via: "edge_replay" }>;
  tenant: AuthenticatedTenant;
  queue_envelope: EdgeQueueEnvelope;
  verified_authorization: VerifiedEdgeAuthorization;
  [EDGE_REPLAY_SOURCE_BRAND]: true;
}>;

const EDGE_INPUT_KEYS = [
  "device_session_id",
  "org_id",
  "store_id",
  "staff_id",
  "device_id",
  "permission_version",
  "queue_envelope",
  "verified_authorization",
] as const;

const VerifiedDeviceSessionContextSchema = z.strictObject({
  device_session_id: z.uuid(),
  org_id: z.uuid(),
  store_id: z.uuid(),
  staff_id: z.uuid(),
  device_id: z.uuid(),
  permission_version: PositiveSafeIntegerSchema,
});

const freezeAuthorization = (
  authorization: z.output<typeof VerifiedEdgeAuthorizationSchema>,
): VerifiedEdgeAuthorization =>
  Object.freeze({
    ...authorization,
    allowed_commands: Object.freeze([...authorization.allowed_commands]),
    primary_lease_commands: Object.freeze([...authorization.primary_lease_commands]),
  });

const requireMatchingAuthorization = (
  envelope: EdgeQueueEnvelope,
  authorization: VerifiedEdgeAuthorization,
): void => {
  const queueAuthorization = envelope.authorization;
  if (
    queueAuthorization.kind !== authorization.kind ||
    queueAuthorization.grant_id !== authorization.grant_id
  ) {
    throw new TypeError("Verified grant authorization does not match the queue envelope");
  }
  if (
    queueAuthorization.kind === "primary_lease" &&
    authorization.kind === "primary_lease" &&
    (queueAuthorization.lease_id !== authorization.lease_id ||
      queueAuthorization.primary_epoch !== authorization.primary_epoch)
  ) {
    throw new TypeError("Verified Primary lease authorization does not match the queue envelope");
  }

  const command = envelope.payload.command;
  if (!authorization.allowed_commands.includes(command)) {
    throw new TypeError("Queued command is not present in the verified authorization");
  }
  if (
    authorization.primary_lease_commands.includes(command) &&
    authorization.kind !== "primary_lease"
  ) {
    throw new TypeError("Queued command requires verified Primary lease authorization");
  }
};

/** Restricted Edge-ingress authority after device session, grant and lease verification. */
export const issueEdgeReplaySource = (input: unknown): EdgeReplaySource => {
  const captured = snapshotExactPlainObject(input, EDGE_INPUT_KEYS, "verified Edge replay");
  const deviceSession = VerifiedDeviceSessionContextSchema.parse({
    device_session_id: captured.device_session_id,
    org_id: captured.org_id,
    store_id: captured.store_id,
    staff_id: captured.staff_id,
    device_id: captured.device_id,
    permission_version: captured.permission_version,
  });
  const queueEnvelope = parseEdgeQueueEnvelope(captured.queue_envelope);
  const authorization = freezeAuthorization(
    VerifiedEdgeAuthorizationSchema.parse(captured.verified_authorization),
  );
  requireMatchingAuthorization(queueEnvelope, authorization);

  const source = Object.freeze({
    kind: "edge_replay" as const,
    device_session_id: deviceSession.device_session_id,
    permission_version: deviceSession.permission_version,
    actor: Object.freeze({
      staff_id: deviceSession.staff_id,
      device_id: deviceSession.device_id,
      via: "edge_replay" as const,
    }),
    tenant: Object.freeze({ org_id: deviceSession.org_id, store_id: deviceSession.store_id }),
    queue_envelope: queueEnvelope,
    verified_authorization: authorization,
  }) as EdgeReplaySource;
  return registerEdgeReplaySource(source);
};
