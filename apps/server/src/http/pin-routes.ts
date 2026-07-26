/**
 * Browser PIN challenge / verify routes (A5 quick_switch + step_up).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  createCommandError,
  PinChallengeRequestSchema,
  PinVerifyRequestSchema,
  type AccessSessionResponse,
  type CommandErrorCode,
} from "@laundry/contracts";

import type {
  AccessSessionProjection,
  AuthorizedSession,
  StaffAuthorityBinding,
} from "../auth/session-view.js";
import { createQuickSwitchChallenge, verifyQuickSwitchPin } from "../identity/pin.js";
import { createStepUpChallenge, verifyStepUpPin } from "../identity/pin-step-up.js";
import type { SessionIssueResult } from "../identity/types.js";
import { IdentityError } from "../identity/types.js";
import type { LocalRuntime } from "../local/demo-seed.js";
import type { CookiePolicy } from "./cookie-policy.js";
import type { SecurityEventSink } from "./security-events.js";

type FailFn = (code: CommandErrorCode) => Readonly<{
  ok: false;
  error: ReturnType<typeof createCommandError>;
}>;

export type PinRouteHelpers = Readonly<{
  runtime: LocalRuntime;
  cookiePolicy: CookiePolicy;
  securityEvents: SecurityEventSink;
  resolveSession: (
    runtime: LocalRuntime,
    request: FastifyRequest,
  ) => Promise<AuthorizedSession | null>;
  requireCsrf: (
    request: FastifyRequest,
    reply: FastifyReply,
    policy: CookiePolicy,
    session: AuthorizedSession["session"],
  ) => Promise<true | ReturnType<FailFn>>;
  mapIdentityHttpError: (
    error: unknown,
    reply: FastifyReply,
    request?: FastifyRequest,
  ) => ReturnType<FailFn>;
  setAuthCookies: (
    reply: FastifyReply,
    policy: CookiePolicy,
    refreshSecret: string,
    csrfToken: string,
  ) => void;
  prepareAccessSessionProjection: (
    binding: StaffAuthorityBinding,
  ) => Promise<AccessSessionProjection | null>;
  buildAccessSessionResponse: (
    issued: SessionIssueResult,
    projection: AccessSessionProjection,
  ) => AccessSessionResponse;
  fail: FailFn;
}>;

type PinSecurityBinding = Readonly<{
  session_id: string;
  staff_id: string;
}>;

function recordPinSecurityError(
  h: PinRouteHelpers,
  request: FastifyRequest,
  error: unknown,
  binding: PinSecurityBinding | null,
): void {
  if (binding === null || !(error instanceof IdentityError)) return;
  const reason =
    error.code === "AUTHENTICATION_FAILED"
      ? "PIN_FAILED"
      : error.code === "PIN_LOCKED"
        ? "PIN_LOCKED"
        : null;
  if (reason === null) return;
  h.securityEvents.record(request, {
    reason,
    ip: request.ip,
    session_id: binding.session_id,
    staff_id: binding.staff_id,
  });
}

export function registerPinRoutes(app: FastifyInstance, h: PinRouteHelpers): void {
  app.post("/api/v2/auth/pin/challenges", async (request, reply) => {
    let securityBinding: PinSecurityBinding | null = null;
    try {
      const resolved = await h.resolveSession(h.runtime, request);
      if (resolved === null) {
        reply.code(401);
        return h.fail("AUTHENTICATION_FAILED");
      }
      const csrf = await h.requireCsrf(request, reply, h.cookiePolicy, resolved.session);
      if (csrf !== true) return csrf;
      const parsed = PinChallengeRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return h.fail("VALIDATION_FAILED");
      }
      const body = parsed.data;
      const targetStaffId =
        body.purpose === "quick_switch" ? body.target_staff_id : body.approver_staff_id;
      securityBinding = Object.freeze({
        session_id: resolved.session.session_id,
        staff_id: targetStaffId,
      });
      if (body.purpose === "quick_switch") {
        const challenge = await createQuickSwitchChallenge(h.runtime.identity.pin, {
          purpose: "quick_switch",
          session: resolved.session,
          target_staff_id: body.target_staff_id,
        });
        return Object.freeze({
          ok: true as const,
          data: Object.freeze({
            challenge_id: challenge.challenge_id,
            purpose: challenge.purpose,
            expires_at: challenge.expires_at,
            max_attempts: challenge.max_attempts,
          }),
        });
      }
      if (h.runtime.identity.pinStepUp !== undefined) {
        const challenge = await createStepUpChallenge(h.runtime.identity.pinStepUp, {
          purpose: "step_up",
          session: resolved.session,
          pending_action_ref: body.pending_action_ref,
          approver_staff_id: body.approver_staff_id,
        });
        return Object.freeze({
          ok: true as const,
          data: Object.freeze({
            challenge_id: challenge.challenge_id,
            purpose: challenge.purpose,
            expires_at: challenge.expires_at,
            max_attempts: challenge.max_attempts,
          }),
        });
      }
      reply.code(400);
      return h.fail("VALIDATION_FAILED");
    } catch (error) {
      recordPinSecurityError(h, request, error, securityBinding);
      return h.mapIdentityHttpError(error, reply, request);
    }
  });

  app.post("/api/v2/auth/pin/challenges/:challengeId/verify", async (request, reply) => {
    let securityBinding: PinSecurityBinding | null = null;
    try {
      const resolved = await h.resolveSession(h.runtime, request);
      if (resolved === null) {
        reply.code(401);
        return h.fail("AUTHENTICATION_FAILED");
      }
      const csrf = await h.requireCsrf(request, reply, h.cookiePolicy, resolved.session);
      if (csrf !== true) return csrf;
      const params = request.params as { challengeId?: string };
      const parsed = PinVerifyRequestSchema.safeParse(request.body);
      if (!parsed.success || params.challengeId !== parsed.data.challenge_id) {
        reply.code(400);
        return h.fail("VALIDATION_FAILED");
      }
      const { challenge_id: challengeId, pin } = parsed.data;
      const record = await h.runtime.identity.pin.challenges.get(challengeId);
      const targetStaffId = record?.target_staff_id ?? record?.approver_staff_id;
      if (targetStaffId !== undefined) {
        securityBinding = Object.freeze({
          session_id: resolved.session.session_id,
          staff_id: targetStaffId,
        });
      }
      if (record?.purpose === "step_up") {
        if (h.runtime.identity.pinStepUp === undefined) {
          reply.code(503);
          return h.fail("RESOURCE_UNAVAILABLE");
        }
        const proof = await verifyStepUpPin(h.runtime.identity.pinStepUp, {
          challenge_id: challengeId,
          pin,
          session: resolved.session,
        });
        // Step-up does not rotate cookies / switch actor (A5).
        return Object.freeze({
          ok: true as const,
          data: Object.freeze({
            step_up_proof_id: proof.step_up_proof_id,
            expires_at: proof.expires_at,
          }),
        });
      }
      if (record?.target_staff_id === undefined) {
        throw new IdentityError("PIN_CHALLENGE_INVALID", "PIN challenge is invalid");
      }
      const projection = await h.prepareAccessSessionProjection({
        org_id: resolved.session.org_id,
        store_id: resolved.session.store_id,
        staff_id: record.target_staff_id,
      });
      if (projection === null) {
        throw new IdentityError("SESSION_INVALID", "Authentication failed");
      }
      const issued = await verifyQuickSwitchPin(h.runtime.identity.pin, {
        challenge_id: challengeId,
        pin,
        session: resolved.session,
        expected_target_permission_version: projection.permission_version,
        expected_target_role: projection.role,
      });
      const accessSession = h.buildAccessSessionResponse(issued, projection);
      h.setAuthCookies(reply, h.cookiePolicy, issued.refresh.refresh_token, issued.csrf.csrf_token);
      return Object.freeze({ ok: true as const, data: accessSession });
    } catch (error) {
      recordPinSecurityError(h, request, error, securityBinding);
      return h.mapIdentityHttpError(error, reply, request);
    }
  });
}
