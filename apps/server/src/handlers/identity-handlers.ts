/**
 * M1 identity command handlers on the C1 bus (A6 command names).
 * Uses C6 services + memory/DI ports; returns A2-shaped success payloads.
 */

import {
  ACCESS_TOKEN_TTL_SECONDS,
  createCommandError,
  createPinChallenge,
  PIN_CHALLENGE_MAX_ATTEMPTS,
} from "@laundry/contracts";

import type { CommandHandler, HandlerContext, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import { newUuid } from "../identity/crypto-util.js";
import type { LoginResult, LoginServiceDeps } from "../identity/login.js";
import { loginWithPassword } from "../identity/login.js";
import type { CreatePinChallengeInput, PinServiceDeps, VerifyPinInput } from "../identity/pin.js";
import { createQuickSwitchChallenge, verifyQuickSwitchPin } from "../identity/pin.js";
import type { LogoutResult, RefreshResult, SessionServiceDeps } from "../identity/session.js";
import { logoutSession, rotateRefresh } from "../identity/session.js";
import {
  IdentityError,
  type IdentityClock,
  type PinChallengeRepository,
  type SessionIssueResult,
  type SessionRecord,
} from "../identity/types.js";

/** Request-scoped secrets / session the HTTP/C8 layer injects (never from wire body alone). */
export type IdentitySessionBinding = Readonly<{
  session: SessionRecord | null;
  refreshSecret: string | null;
}>;

export type IdentityHandlerDeps = Readonly<{
  login: LoginServiceDeps;
  sessions: SessionServiceDeps;
  pin: PinServiceDeps;
  /** Required for step_up pin_challenge skeleton. */
  pinChallenges?: PinChallengeRepository;
  clock?: IdentityClock;
  resolveBinding: (ctx: HandlerContext) => IdentitySessionBinding | Promise<IdentitySessionBinding>;
}>;

export type IdentityHandlerMap = Readonly<Record<string, CommandHandler>>;

const IDENTITY_HANDLER_NAMES = Object.freeze([
  "identity.login",
  "identity.refresh",
  "identity.logout",
  "identity.pin_challenge",
  "identity.pin_verify",
] as const);

export type IdentityHandlerName = (typeof IDENTITY_HANDLER_NAMES)[number];

export function identityHandlerNames(): readonly IdentityHandlerName[] {
  return IDENTITY_HANDLER_NAMES;
}

function asRecord(parsed: unknown): Readonly<Record<string, unknown>> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function requireString(value: unknown, _field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function mapIdentityError(error: unknown): never {
  if (error instanceof HandlerCommandError) throw error;
  if (error instanceof IdentityError) {
    switch (error.code) {
      case "AUTHENTICATION_FAILED":
        throw new HandlerCommandError(createCommandError("AUTHENTICATION_FAILED"));
      case "CSRF_REJECTED":
        throw new HandlerCommandError(createCommandError("CSRF_REJECTED"));
      case "PIN_LOCKED":
        throw new HandlerCommandError(createCommandError("RATE_LIMITED"));
      case "PIN_CHALLENGE_INVALID":
        throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
      case "SESSION_INVALID":
        throw new HandlerCommandError(createCommandError("AUTHENTICATION_FAILED"));
      default:
        throw new HandlerCommandError(createCommandError("TRANSACTION_FAILED"));
    }
  }
  throw error;
}

/** Project C6 session issue result to A2 AccessSessionResponse fields. */
export function toAccessSessionResponse(issued: SessionIssueResult): Readonly<{
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  storage: "memory_only";
  session: SessionIssueResult["session"];
}> {
  return Object.freeze({
    access_token: issued.access_token,
    token_type: "Bearer" as const,
    expires_in: issued.expires_in ?? ACCESS_TOKEN_TTL_SECONDS,
    storage: "memory_only" as const,
    session: issued.session,
  });
}

function loginHandler(deps: IdentityHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    try {
      const issued: LoginResult = await loginWithPassword(deps.login, ctx.parsed);
      return Object.freeze({
        result: toAccessSessionResponse(issued),
        audit: Object.freeze({
          entity: "session",
          entityId: issued.session.session_id,
          afterJson: JSON.stringify({
            staff_id: issued.session.staff_id,
            device_id: issued.session.device_id,
          }),
        }),
        events: Object.freeze([
          Object.freeze({
            type: "identity.session_opened",
            payload: Object.freeze({ session_id: issued.session.session_id }),
          }),
        ]),
      });
    } catch (error) {
      mapIdentityError(error);
    }
  };
}

function refreshHandler(deps: IdentityHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    try {
      const binding = await deps.resolveBinding(ctx);
      if (binding.refreshSecret === null) {
        throw new HandlerCommandError(createCommandError("AUTHENTICATION_FAILED"));
      }
      const issued: RefreshResult = await rotateRefresh(deps.sessions, binding.refreshSecret);
      return Object.freeze({
        result: toAccessSessionResponse(issued),
        audit: Object.freeze({
          entity: "session",
          entityId: issued.session.session_id,
        }),
        events: Object.freeze([
          Object.freeze({
            type: "identity.session_rotated",
            payload: Object.freeze({ session_id: issued.session.session_id }),
          }),
        ]),
      });
    } catch (error) {
      mapIdentityError(error);
    }
  };
}

function logoutHandler(deps: IdentityHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    try {
      const binding = await deps.resolveBinding(ctx);
      if (binding.session === null) {
        throw new HandlerCommandError(createCommandError("AUTHENTICATION_FAILED"));
      }
      const session = binding.session;
      const result: LogoutResult = await logoutSession(deps.sessions, {
        session_id: session.session_id,
        family_id: session.family_id,
        session_version: session.session_version,
      });
      return Object.freeze({
        result: Object.freeze({ logged_out: result.logged_out }),
        audit: Object.freeze({
          entity: "session",
          entityId: session.session_id,
        }),
        events: Object.freeze([
          Object.freeze({
            type: "identity.session_revoked",
            payload: Object.freeze({ session_id: session.session_id }),
          }),
        ]),
      });
    } catch (error) {
      mapIdentityError(error);
    }
  };
}

async function issueQuickSwitchChallenge(
  deps: IdentityHandlerDeps,
  session: SessionRecord,
  targetStaffId: string,
): Promise<HandlerOutcome> {
  const input: CreatePinChallengeInput = Object.freeze({
    purpose: "quick_switch",
    session,
    target_staff_id: targetStaffId,
  });
  const view = await createQuickSwitchChallenge(deps.pin, input);
  return Object.freeze({
    result: Object.freeze({
      challenge_id: view.challenge_id,
      purpose: view.purpose,
      expires_at: view.expires_at,
      max_attempts: view.max_attempts,
    }),
    audit: Object.freeze({
      entity: "pin_challenge",
      entityId: view.challenge_id,
    }),
    events: Object.freeze([
      Object.freeze({
        type: "identity.pin_challenge_issued",
        payload: Object.freeze({ challenge_id: view.challenge_id, purpose: view.purpose }),
      }),
    ]),
  });
}

async function issueStepUpChallenge(
  deps: IdentityHandlerDeps,
  session: SessionRecord,
  pendingActionRef: string,
  approverStaffId: string,
): Promise<HandlerOutcome> {
  if (deps.pinChallenges === undefined || deps.clock === undefined) {
    throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
  }
  if (approverStaffId === session.staff_id) {
    throw new HandlerCommandError(createCommandError("PERMISSION_DENIED"));
  }
  const now = deps.clock.nowEpochSeconds();
  // Skeleton: bind challenge to opaque ref; full pending-card join is residual.
  const argsHash = "0".repeat(64);
  const raw = createPinChallenge({
    purpose: "step_up",
    challenge_id: newUuid(),
    session_id: session.session_id,
    session_version: session.session_version,
    org_id: session.org_id,
    store_id: session.store_id,
    device_id: session.device_id,
    nonce: newUuid(),
    issued_at: now,
    pending_action_ref: pendingActionRef,
    args_hash: argsHash,
    entity_versions: [],
    idempotency_key: newUuid(),
    requester_staff_id: session.staff_id,
    approver_staff_id: approverStaffId,
  });
  if (raw.purpose !== "step_up") {
    throw new HandlerCommandError(createCommandError("TRANSACTION_FAILED"));
  }
  await deps.pinChallenges.insert(
    Object.freeze({
      challenge_id: raw.challenge_id,
      purpose: "step_up" as const,
      session_id: raw.session_id,
      session_version: raw.session_version,
      org_id: raw.org_id,
      store_id: raw.store_id,
      device_id: raw.device_id,
      nonce: raw.nonce,
      issued_at: raw.issued_at,
      expires_at: raw.expires_at,
      status: raw.status,
      failed_attempts: raw.failed_attempts,
      max_attempts: raw.max_attempts,
      requester_staff_id: raw.requester_staff_id,
      pending_action_ref: raw.pending_action_ref,
      args_hash: raw.args_hash,
      entity_versions: raw.entity_versions,
      idempotency_key: raw.idempotency_key,
      approver_staff_id: raw.approver_staff_id,
    }),
  );
  return Object.freeze({
    result: Object.freeze({
      challenge_id: raw.challenge_id,
      purpose: raw.purpose,
      expires_at: raw.expires_at,
      max_attempts: PIN_CHALLENGE_MAX_ATTEMPTS,
    }),
    audit: Object.freeze({
      entity: "pin_challenge",
      entityId: raw.challenge_id,
    }),
    events: Object.freeze([
      Object.freeze({
        type: "identity.pin_challenge_issued",
        payload: Object.freeze({
          challenge_id: raw.challenge_id,
          purpose: raw.purpose,
        }),
      }),
    ]),
  });
}

function pinChallengeHandler(deps: IdentityHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    try {
      const binding = await deps.resolveBinding(ctx);
      if (binding.session === null) {
        throw new HandlerCommandError(createCommandError("AUTHENTICATION_FAILED"));
      }
      const input = asRecord(ctx.parsed);
      const purpose = requireString(input.purpose, "purpose");
      if (purpose === "quick_switch") {
        const target = requireString(input.target_staff_id, "target_staff_id");
        return await issueQuickSwitchChallenge(deps, binding.session, target);
      }
      if (purpose === "step_up") {
        const pendingRef = requireString(input.pending_action_ref, "pending_action_ref");
        const approver = requireString(input.approver_staff_id, "approver_staff_id");
        return await issueStepUpChallenge(deps, binding.session, pendingRef, approver);
      }
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    } catch (error) {
      mapIdentityError(error);
    }
  };
}

function pinVerifyHandler(deps: IdentityHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    try {
      const binding = await deps.resolveBinding(ctx);
      if (binding.session === null) {
        throw new HandlerCommandError(createCommandError("AUTHENTICATION_FAILED"));
      }
      const input = asRecord(ctx.parsed);
      const challengeId = requireString(input.challenge_id, "challenge_id");
      const pin = requireString(input.pin, "pin");
      const verifyInput: VerifyPinInput = Object.freeze({
        challenge_id: challengeId,
        pin,
        session: binding.session,
      });
      const issued = await verifyQuickSwitchPin(deps.pin, verifyInput);
      return Object.freeze({
        result: toAccessSessionResponse(issued),
        audit: Object.freeze({
          entity: "session",
          entityId: issued.session.session_id,
        }),
        events: Object.freeze([
          Object.freeze({
            type: "identity.pin_verified",
            payload: Object.freeze({
              challenge_id: challengeId,
              session_id: issued.session.session_id,
            }),
          }),
        ]),
      });
    } catch (error) {
      mapIdentityError(error);
    }
  };
}

/** Build bus-shaped handlers for all A6 identity command names. */
export function createIdentityHandlers(deps: IdentityHandlerDeps): IdentityHandlerMap {
  return Object.freeze({
    "identity.login": loginHandler(deps),
    "identity.refresh": refreshHandler(deps),
    "identity.logout": logoutHandler(deps),
    "identity.pin_challenge": pinChallengeHandler(deps),
    "identity.pin_verify": pinVerifyHandler(deps),
  });
}

/** Register identity *command* handlers onto a C1 registry. */
export function registerIdentityCommandHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: IdentityHandlerDeps,
): void {
  const handlers = createIdentityHandlers(deps);
  for (const name of IDENTITY_HANDLER_NAMES) {
    registry.registerHandler(name, handlers[name]!);
  }
}
