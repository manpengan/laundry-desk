/**
 * M1 identity command handlers on the C1 bus (A6 command names).
 * Uses C6 services + memory/DI ports; returns A2-shaped success payloads.
 */

import { ACCESS_TOKEN_TTL_SECONDS, createCommandError } from "@laundry/contracts";

import type { CommandHandler, HandlerContext, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { LoginResult, LoginServiceDeps } from "../identity/login.js";
import { loginWithPassword } from "../identity/login.js";
import type { CreatePinChallengeInput, PinServiceDeps, VerifyPinInput } from "../identity/pin.js";
import { createQuickSwitchChallenge, verifyQuickSwitchPin } from "../identity/pin.js";
import {
  createStepUpChallenge,
  verifyStepUpPin,
  type PinStepUpDeps,
} from "../identity/pin-step-up.js";
import type { LogoutResult, RefreshResult, SessionServiceDeps } from "../identity/session.js";
import { logoutSession, rotateRefresh } from "../identity/session.js";
import { IdentityError, type SessionIssueResult, type SessionRecord } from "../identity/types.js";

/** Request-scoped secrets / session the HTTP/C8 layer injects (never from wire body alone). */
export type IdentitySessionBinding = Readonly<{
  session: SessionRecord | null;
  refreshSecret: string | null;
}>;

export type IdentityHandlerDeps = Readonly<{
  login: LoginServiceDeps;
  sessions: SessionServiceDeps;
  pin: PinServiceDeps;
  /** Required for purpose=step_up challenge/verify (pending + proof stores). */
  pinStepUp?: PinStepUpDeps;
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

function requireString(value: unknown, field: string): string {
  void field;
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
  if (deps.pinStepUp === undefined) {
    throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
  }
  const view = await createStepUpChallenge(deps.pinStepUp, {
    purpose: "step_up",
    session,
    pending_action_ref: pendingActionRef,
    approver_staff_id: approverStaffId,
  });
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
        payload: Object.freeze({
          challenge_id: view.challenge_id,
          purpose: view.purpose,
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
      const record = await deps.pin.challenges.get(challengeId);

      if (record?.purpose === "step_up") {
        if (deps.pinStepUp === undefined) {
          throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
        }
        const proof = await verifyStepUpPin(deps.pinStepUp, {
          challenge_id: challengeId,
          pin,
          session: binding.session,
        });
        return Object.freeze({
          result: Object.freeze({
            step_up_proof_id: proof.step_up_proof_id,
            expires_at: proof.expires_at,
          }),
          audit: Object.freeze({
            entity: "step_up_proof",
            entityId: proof.step_up_proof_id,
          }),
          events: Object.freeze([
            Object.freeze({
              type: "identity.pin_verified",
              payload: Object.freeze({
                challenge_id: challengeId,
                purpose: "step_up",
                step_up_proof_id: proof.step_up_proof_id,
              }),
            }),
          ]),
        });
      }

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
