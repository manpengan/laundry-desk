import { z } from "zod";

import {
  isBrowserSessionSource,
  isEdgeReplaySource,
  type AuthenticatedActor,
  type AuthenticatedExecutionSource,
  type AuthenticatedTenant,
} from "../auth/session.js";
import { plainDataEquals, snapshotPlainData } from "../auth/plain-data.js";
import { parseUnbrandedCommandWirePayload } from "./wire-payload.js";

/** Architecture §6.5 / ADR-05 #1: the audited source of an authenticated command. */
export const CommandViaSchema = z.enum(["ui", "ai", "automation", "edge_replay"]);

type AuthenticatedCommandContext = Readonly<{
  actor: AuthenticatedActor;
  tenant: AuthenticatedTenant;
}>;

declare const SERVER_COMMAND_ENVELOPE_BRAND: unique symbol;

type ServerCommandEnvelopeBrand = Readonly<{
  [SERVER_COMMAND_ENVELOPE_BRAND]: true;
}>;

type ParsedCommandWirePayload = ReturnType<typeof parseUnbrandedCommandWirePayload>;
type ServerEnvelopeFields = Readonly<ParsedCommandWirePayload & AuthenticatedCommandContext>;

/**
 * C1's internal dynamic command representation. The private brand and registration are only
 * created by `injectAuthenticatedCommandContext`, so matching JSON cannot establish provenance.
 */
export type ServerCommandEnvelope = Readonly<ServerEnvelopeFields> & ServerCommandEnvelopeBrand;

const registeredServerEnvelopes = new WeakMap<object, true>();

const freezeContext = (context: AuthenticatedCommandContext): AuthenticatedCommandContext =>
  Object.freeze({
    actor: Object.freeze({ ...context.actor }),
    tenant: Object.freeze({ ...context.tenant }),
  });

const registerServerEnvelope = (fields: ServerEnvelopeFields): ServerCommandEnvelope => {
  const envelope = Object.freeze(fields);
  registeredServerEnvelopes.set(envelope, true);
  return envelope as ServerCommandEnvelope;
};

/**
 * C8 calls this after authentication and before the C1 validation chain. It accepts no actor or
 * tenant fields from the wire payload, and it never exposes an unbranded construction path.
 */
export const injectAuthenticatedCommandContext = (
  wirePayload: unknown,
  source: AuthenticatedExecutionSource,
): ServerCommandEnvelope => {
  const wireSnapshot = snapshotPlainData(wirePayload, "command wire payload");
  const wire = parseUnbrandedCommandWirePayload(wireSnapshot);
  if (!isBrowserSessionSource(source) && !isEdgeReplaySource(source)) {
    throw new TypeError("Authenticated execution source requires registered provenance");
  }
  if (isEdgeReplaySource(source) && source.actor.via !== "edge_replay") {
    throw new TypeError("Authenticated execution source does not match actor via");
  }
  if (
    isEdgeReplaySource(source) &&
    !plainDataEquals(
      snapshotPlainData(wire, "parsed command wire payload"),
      snapshotPlainData(source.queue_envelope.payload, "verified Edge queue payload"),
    )
  ) {
    throw new TypeError("Edge source does not match the verified queue payload");
  }
  const context = freezeContext({ actor: source.actor, tenant: source.tenant });
  return registerServerEnvelope({ ...wire, ...context });
};

/** Returns true only for envelopes emitted by this module's authenticated-context injection. */
export const isServerCommandEnvelope = (value: unknown): value is ServerCommandEnvelope =>
  typeof value === "object" && value !== null && registeredServerEnvelopes.has(value);
