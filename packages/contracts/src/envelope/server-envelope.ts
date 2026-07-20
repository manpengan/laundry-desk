import { z } from "zod";

import { parseUnbrandedCommandWirePayload } from "./wire-payload.js";

/** Architecture §6.5 / ADR-05 #1: the audited source of an authenticated command. */
export const CommandViaSchema = z.enum(["ui", "ai", "automation", "edge_replay"]);

const AuthenticatedActorSchema = z
  .object({
    /** C8 injects this identity from the authenticated server-side session only. */
    staff_id: z.uuid(),
    /** C8 resolves the authenticated workstation or registered Edge device. */
    device_id: z.uuid(),
    /** C1/C3/C5 use the source to select Policy and audit behavior. */
    via: CommandViaSchema,
  })
  .strict();

const AuthenticatedTenantSchema = z
  .object({
    /** ADR-02 #10: organization identity is never caller supplied. */
    org_id: z.uuid(),
    /** ADR-02 #10: store identity is never caller supplied. */
    store_id: z.uuid(),
  })
  .strict();

/**
 * C8's trusted input to A2 injection. Parsing validates shape only; C8 remains responsible for
 * deriving it from the server authentication session rather than a browser, LLM, or Edge request.
 */
export const AuthenticatedCommandContextSchema = z
  .object({ actor: AuthenticatedActorSchema, tenant: AuthenticatedTenantSchema })
  .strict();

type AuthenticatedActor = Readonly<z.output<typeof AuthenticatedActorSchema>>;
type AuthenticatedTenant = Readonly<z.output<typeof AuthenticatedTenantSchema>>;
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
  authenticatedContext: unknown,
): ServerCommandEnvelope => {
  const wire = parseUnbrandedCommandWirePayload(wirePayload);
  const context = freezeContext(AuthenticatedCommandContextSchema.parse(authenticatedContext));
  return registerServerEnvelope({ ...wire, ...context });
};

/** Returns true only for envelopes emitted by this module's authenticated-context injection. */
export const isServerCommandEnvelope = (value: unknown): value is ServerCommandEnvelope =>
  typeof value === "object" && value !== null && registeredServerEnvelopes.has(value);
