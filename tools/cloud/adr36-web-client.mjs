import { randomUUID as systemRandomUUID } from "node:crypto";

import { asRecord, requireThat, requireUuid } from "./adr36-web-core.mjs";
import {
  CSRF_COOKIE,
  REFRESH_COOKIE,
  executedResult,
  parseAccessSession,
  remoteFailure,
  requireAuthCookies,
  transport,
} from "./adr36-web-client-transport.mjs";

export { applySetCookieHeaders } from "./adr36-web-client-transport.mjs";

const ORG_CODE = "local";
const STORE_CODE = "main";
const REQUEST_TIMEOUT_MS = 15_000;
const COMMAND_VERSIONS = Object.freeze({
  "catalog.item.upsert": "0.3.0",
  "catalog.items.reorder": "0.1.0",
  "customer.upsert": "0.2.0",
  "customer.profile.set": "1.0.0",
  "customer.discount_policy.set": "1.0.0",
  "order.receive": "0.3.0",
  "order.pickup": "0.3.0",
  "order.cancel": "0.3.0",
  "garment.transition": "0.1.0",
  "garment.rack.assign": "0.1.0",
  "print.ticket.enqueue": "0.3.0",
  "member.account.open": "1.0.0",
  "member.topup": "1.0.0",
  "member.balance.pay": "1.0.0",
  "member.bonus_rule.upsert": "1.0.0",
  "member.refund": "1.0.0",
  "member.account.freeze": "1.0.0",
  "member.account.unfreeze": "1.0.0",
  "member.account.close": "1.0.0",
  "member.benefit_definition.upsert": "1.0.0",
  "member.membership.set": "1.0.0",
  "member.points.earn": "1.0.0",
  "member.points.redeem": "1.0.0",
  "member.asset.grant": "1.0.0",
  "member.asset.consume": "1.0.0",
  "staff.create": "1.0.0",
  "staff.credentials.reset": "1.0.0",
  "staff.access.set": "1.0.0",
  "payment.repay": "0.2.0",
  "payment.refund": "0.2.0",
  "accounting.report.export": "0.1.0",
  "notification.manual_list.create": "0.1.0",
  "notification.delivery_batch.enqueue": "0.1.0",
  "shift.close": "0.3.0",
  "store.profile.set": "0.1.0",
});

export function createAcceptanceClient(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const randomUUID = options.randomUUID ?? systemRandomUUID;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  requireThat(typeof fetchImpl === "function", "FETCH_UNAVAILABLE");
  const newUuid = () => requireUuid(randomUUID(), "RANDOM_UUID_INVALID");

  const login = async (principal, expectedRole = "admin") => {
    requireThat(expectedRole === "admin" || expectedRole === "staff", "LOGIN_ROLE_INVALID");
    const outcome = await transport(fetchImpl, {
      path: "/api/v2/auth/login",
      body: {
        org_code: ORG_CODE,
        store_code: STORE_CODE,
        username: principal.username,
        password: principal.password,
        device_id: newUuid(),
      },
      timeoutMs,
    });
    if (!outcome.ok) remoteFailure(outcome);
    requireThat(outcome.cookiesTouched, "AUTH_COOKIES_MISSING");
    requireAuthCookies(outcome.cookies);
    const parsed = parseAccessSession(outcome.data, expectedRole);
    requireThat(parsed.display.staff_name === principal.displayName, "LOGIN_AUTHORITY_INVALID");
    return Object.freeze({ ...parsed, cookies: outcome.cookies });
  };

  const expectLoginFailure = async (principal, expectedCode = "AUTHENTICATION_FAILED") => {
    const outcome = await transport(fetchImpl, {
      path: "/api/v2/auth/login",
      body: {
        org_code: ORG_CODE,
        store_code: STORE_CODE,
        username: principal.username,
        password: principal.password,
        device_id: newUuid(),
      },
      timeoutMs,
    });
    requireThat(
      !outcome.ok && outcome.code === expectedCode && !outcome.cookiesTouched,
      "EXPECTED_LOGIN_FAILURE_MISSING",
    );
  };

  const completeStaffCredentials = async (session, input) => {
    const outcome = await transport(fetchImpl, {
      path: "/api/v2/auth/staff/credentials/complete",
      session,
      withCookies: true,
      body: input,
      timeoutMs,
    });
    requireThat(!outcome.cookiesTouched, "UNEXPECTED_COOKIE_ROTATION");
    if (!outcome.ok) remoteFailure(outcome);
    return outcome.data;
  };

  const expectRefreshFailure = async (session, expectedCode = "AUTHENTICATION_FAILED") => {
    const outcome = await transport(fetchImpl, {
      path: "/api/v2/auth/refresh",
      session,
      withCookies: true,
      body: {},
      timeoutMs,
    });
    requireThat(
      !outcome.ok &&
        outcome.code === expectedCode &&
        outcome.cookiesTouched &&
        Object.keys(outcome.cookies).length === 0,
      "EXPECTED_REFRESH_FAILURE_MISSING",
    );
  };

  const refresh = async (session) => {
    const previousRefresh = session.cookies[REFRESH_COOKIE];
    const previousCsrf = session.cookies[CSRF_COOKIE];
    const outcome = await transport(fetchImpl, {
      path: "/api/v2/auth/refresh",
      session,
      withCookies: true,
      body: {},
      timeoutMs,
    });
    if (!outcome.ok) remoteFailure(outcome);
    requireAuthCookies(outcome.cookies);
    requireThat(
      outcome.cookiesTouched &&
        outcome.cookies[REFRESH_COOKIE] !== previousRefresh &&
        outcome.cookies[CSRF_COOKIE] !== previousCsrf,
      "REFRESH_ROTATION_INVALID",
    );
    const parsed = parseAccessSession(outcome.data, session.role);
    requireThat(
      parsed.staffId === session.staffId &&
        parsed.sessionId === session.sessionId &&
        parsed.orgId === session.orgId &&
        parsed.storeId === session.storeId &&
        parsed.deviceId === session.deviceId &&
        parsed.sessionVersion === session.sessionVersion &&
        parsed.permissionVersion === session.permissionVersion,
      "REFRESH_SESSION_INVALID",
    );
    return Object.freeze({ ...parsed, cookies: outcome.cookies });
  };

  const direct = async (session, name, args, idempotencyKey = newUuid()) => {
    const version = COMMAND_VERSIONS[name];
    requireThat(typeof version === "string", "COMMAND_VERSION_MISSING");
    const outcome = await transport(fetchImpl, {
      path: `/v1/commands/${encodeURIComponent(name)}`,
      session,
      withCookies: true,
      body: {
        command: name,
        version,
        idempotency_key: idempotencyKey,
        dry_run: false,
        mode: "direct",
        args,
      },
      timeoutMs,
    });
    requireThat(!outcome.cookiesTouched, "UNEXPECTED_COOKIE_ROTATION");
    return Object.freeze({ outcome, idempotencyKey, version });
  };

  const confirm = async (session, name, version, idempotencyKey, confirmRef) => {
    const outcome = await transport(fetchImpl, {
      path: `/v1/commands/${encodeURIComponent(name)}`,
      session,
      withCookies: true,
      body: {
        command: name,
        version,
        idempotency_key: idempotencyKey,
        dry_run: false,
        mode: "confirm",
        confirm_ref: confirmRef,
      },
      timeoutMs,
    });
    requireThat(!outcome.cookiesTouched, "UNEXPECTED_COOKIE_ROTATION");
    return executedResult(outcome);
  };

  const command = async (session, name, args) =>
    executedResult((await direct(session, name, args)).outcome);

  const expectCommandFailure = async (session, name, args, expectedCode) => {
    const attempted = await direct(session, name, args);
    requireThat(
      !attempted.outcome.ok && attempted.outcome.code === expectedCode,
      "EXPECTED_COMMAND_FAILURE_MISSING",
    );
  };

  const gatedReplayable = async (session, name, args, expectedCode, approve) => {
    const first = await direct(session, name, args);
    requireThat(!first.outcome.ok && first.outcome.code === expectedCode, "POLICY_GATE_INVALID");
    const confirmRef = requireUuid(first.outcome.confirmRef, "CONFIRM_REFERENCE_MISSING");
    if (approve !== undefined) await approve(confirmRef);
    const replay = () => confirm(session, name, first.version, first.idempotencyKey, confirmRef);
    return Object.freeze({ result: await replay(), replay });
  };

  const approveStepUp = async (session, confirmRef, approverStaffId, pin) => {
    const challenge = await transport(fetchImpl, {
      path: "/api/v2/auth/pin/challenges",
      session,
      withCookies: true,
      body: {
        purpose: "step_up",
        pending_action_ref: confirmRef,
        approver_staff_id: approverStaffId,
      },
      timeoutMs,
    });
    if (!challenge.ok) remoteFailure(challenge);
    requireThat(!challenge.cookiesTouched, "UNEXPECTED_COOKIE_ROTATION");
    const challengeId = requireUuid(asRecord(challenge.data).challenge_id, "PIN_CHALLENGE_INVALID");
    const verified = await transport(fetchImpl, {
      path: `/api/v2/auth/pin/challenges/${encodeURIComponent(challengeId)}/verify`,
      session,
      withCookies: true,
      body: { challenge_id: challengeId, pin },
      timeoutMs,
    });
    if (!verified.ok) remoteFailure(verified);
    requireThat(!verified.cookiesTouched, "UNEXPECTED_COOKIE_ROTATION");
    requireUuid(asRecord(verified.data).step_up_proof_id, "PIN_PROOF_INVALID");
  };

  const confirmReplayable = (session, name, args) =>
    gatedReplayable(session, name, args, "POLICY_CONFIRMATION_REQUIRED");
  const stepUpReplayable = (session, name, args, approverStaffId, pin) =>
    gatedReplayable(session, name, args, "POLICY_STEP_UP_REQUIRED", (confirmRef) =>
      approveStepUp(session, confirmRef, approverStaffId, pin),
    );
  const gated = async (...args) => (await gatedReplayable(...args)).result;
  const stepUp = async (...args) => (await stepUpReplayable(...args)).result;

  const query = async (session, name, args) => {
    const outcome = await transport(fetchImpl, {
      path: `/v1/queries/${encodeURIComponent(name)}`,
      session,
      body: args,
      timeoutMs,
    });
    requireThat(!outcome.cookiesTouched, "UNEXPECTED_COOKIE_ROTATION");
    return executedResult(outcome);
  };

  const staff = async (session) => {
    const outcome = await transport(fetchImpl, {
      path: "/api/v2/local/staff",
      method: "GET",
      session,
      timeoutMs,
    });
    requireThat(!outcome.cookiesTouched, "UNEXPECTED_COOKIE_ROTATION");
    if (!outcome.ok) remoteFailure(outcome);
    return outcome.data;
  };

  const expectStaffFailure = async (session, expectedCode = "AUTHENTICATION_FAILED") => {
    const outcome = await transport(fetchImpl, {
      path: "/api/v2/local/staff",
      method: "GET",
      session,
      timeoutMs,
    });
    requireThat(
      !outcome.ok && outcome.code === expectedCode && !outcome.cookiesTouched,
      "EXPECTED_STAFF_FAILURE_MISSING",
    );
  };

  const logout = async (session) => {
    const outcome = await transport(fetchImpl, {
      path: "/api/v2/auth/logout",
      session,
      withCookies: true,
      body: {},
      timeoutMs,
    });
    if (!outcome.ok) remoteFailure(outcome);
    requireThat(
      outcome.cookiesTouched && Object.keys(outcome.cookies).length === 0,
      "LOGOUT_COOKIE_CLEAR_INVALID",
    );
    await expectStaffFailure(session);
    await expectRefreshFailure(session);
  };

  return Object.freeze({
    login,
    expectLoginFailure,
    refresh,
    expectRefreshFailure,
    completeStaffCredentials,
    command,
    expectCommandFailure,
    confirm: (session, name, args) => gated(session, name, args, "POLICY_CONFIRMATION_REQUIRED"),
    confirmReplayable,
    stepUp,
    stepUpReplayable,
    query,
    staff,
    expectStaffFailure,
    logout,
    newUuid,
  });
}
