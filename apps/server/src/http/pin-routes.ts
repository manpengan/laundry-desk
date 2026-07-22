/**
 * Browser PIN challenge / verify routes (A5 quick_switch + step_up).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { createCommandError, type CommandErrorCode } from "@laundry/contracts";

import { createQuickSwitchChallenge, verifyQuickSwitchPin } from "../identity/pin.js";
import { createStepUpChallenge, verifyStepUpPin } from "../identity/pin-step-up.js";
import type { SessionIssueResult, SessionRecord } from "../identity/types.js";
import type { LocalRuntime } from "../local/demo-seed.js";
import type { CookiePolicy } from "./cookie-policy.js";

type FailFn = (code: CommandErrorCode) => Readonly<{
  ok: false;
  error: ReturnType<typeof createCommandError>;
}>;

export type PinRouteHelpers = Readonly<{
  runtime: LocalRuntime;
  cookiePolicy: CookiePolicy;
  readBearer: (request: FastifyRequest) => string | null;
  resolveSession: (runtime: LocalRuntime, token: string | null) => Promise<SessionRecord | null>;
  requireCsrf: (
    request: FastifyRequest,
    reply: FastifyReply,
    policy: CookiePolicy,
  ) => true | ReturnType<FailFn>;
  mapIdentityHttpError: (error: unknown, reply: FastifyReply) => ReturnType<FailFn>;
  setAuthCookies: (
    reply: FastifyReply,
    policy: CookiePolicy,
    refreshSecret: string,
    csrfToken: string,
  ) => void;
  publicAccessBody: (issued: SessionIssueResult) => unknown;
  isRecord: (value: unknown) => value is Record<string, unknown>;
  fail: FailFn;
}>;

export function registerPinRoutes(app: FastifyInstance, h: PinRouteHelpers): void {
  app.post("/api/v2/auth/pin/challenges", async (request, reply) => {
    const session = await h.resolveSession(h.runtime, h.readBearer(request));
    if (session === null) {
      reply.code(401);
      return h.fail("AUTHENTICATION_FAILED");
    }
    const csrf = h.requireCsrf(request, reply, h.cookiePolicy);
    if (csrf !== true) return csrf;
    const body = h.isRecord(request.body) ? request.body : {};
    try {
      if (body.purpose === "quick_switch" && typeof body.target_staff_id === "string") {
        const challenge = await createQuickSwitchChallenge(h.runtime.identity.pin, {
          purpose: "quick_switch",
          session,
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
      if (
        body.purpose === "step_up" &&
        typeof body.pending_action_ref === "string" &&
        typeof body.approver_staff_id === "string" &&
        h.runtime.identity.pinStepUp !== undefined
      ) {
        const challenge = await createStepUpChallenge(h.runtime.identity.pinStepUp, {
          purpose: "step_up",
          session,
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
      return h.mapIdentityHttpError(error, reply);
    }
  });

  app.post("/api/v2/auth/pin/challenges/:challengeId/verify", async (request, reply) => {
    const session = await h.resolveSession(h.runtime, h.readBearer(request));
    if (session === null) {
      reply.code(401);
      return h.fail("AUTHENTICATION_FAILED");
    }
    const csrf = h.requireCsrf(request, reply, h.cookiePolicy);
    if (csrf !== true) return csrf;
    const params = request.params as { challengeId?: string };
    const body = h.isRecord(request.body) ? request.body : {};
    const challengeId =
      typeof body.challenge_id === "string"
        ? body.challenge_id
        : typeof params.challengeId === "string"
          ? params.challengeId
          : "";
    const pin = typeof body.pin === "string" ? body.pin : "";
    try {
      const record = await h.runtime.identity.pin.challenges.get(challengeId);
      if (record?.purpose === "step_up") {
        if (h.runtime.identity.pinStepUp === undefined) {
          reply.code(503);
          return h.fail("RESOURCE_UNAVAILABLE");
        }
        const proof = await verifyStepUpPin(h.runtime.identity.pinStepUp, {
          challenge_id: challengeId,
          pin,
          session,
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
      const issued = await verifyQuickSwitchPin(h.runtime.identity.pin, {
        challenge_id: challengeId,
        pin,
        session,
      });
      h.setAuthCookies(reply, h.cookiePolicy, issued.refresh.refresh_token, issued.csrf.csrf_token);
      return Object.freeze({ ok: true as const, data: h.publicAccessBody(issued) });
    } catch (error) {
      return h.mapIdentityHttpError(error, reply);
    }
  });
}
