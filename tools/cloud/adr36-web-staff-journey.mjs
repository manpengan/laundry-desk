import { randomBytes, randomInt } from "node:crypto";

import { asRecord, failureCode, requireString, requireThat } from "./adr36-web-core.mjs";
import {
  requireStaffJourneyApi,
  requireStaffSession,
  staffAccessChangeResult,
  staffAccessRow,
  staffCompletionResult,
  staffSetupResult,
  staffSyntheticIdentity,
} from "./adr36-web-staff-support.mjs";

const SECRET_KINDS = Object.freeze(["initial", "replacement", "recovery"]);

function defaultSecretFactory() {
  return Object.freeze({
    password: `ADR36!${randomBytes(24).toString("base64url")}`,
    pin: String(randomInt(0, 100_000_000)).padStart(8, "0"),
  });
}

function loadSecrets(secretFactory) {
  requireThat(typeof secretFactory === "function", "STAFF_SECRET_FACTORY_INVALID");
  const entries = SECRET_KINDS.map((kind) => {
    const secret = asRecord(secretFactory(kind), "STAFF_SECRET_INVALID");
    const password = requireString(secret.password, "STAFF_SECRET_INVALID");
    const pin = requireString(secret.pin, "STAFF_SECRET_INVALID");
    requireThat(password.length >= 12 && password.length <= 256, "STAFF_SECRET_INVALID");
    requireThat(/^\d{6,8}$/u.test(pin), "STAFF_SECRET_INVALID");
    return [kind, Object.freeze({ password, pin })];
  });
  requireThat(
    new Set(entries.map(([, value]) => value.password)).size === SECRET_KINDS.length &&
      new Set(entries.map(([, value]) => value.pin)).size === SECRET_KINDS.length,
    "STAFF_SECRETS_NOT_DISTINCT",
  );
  return Object.freeze(Object.fromEntries(entries));
}

/**
 * Build a one-shot employee credential journey with independently repeatable cleanup.
 * Passwords, PINs, and employee sessions remain in the returned methods' closure and are
 * never included in the execute result or an external artifact patch.
 *
 * @param {Readonly<{
 *   api: object,
 *   adminSession: object,
 *   approverSession: object,
 *   approverPin: string,
 *   run: object,
 *   secretFactory?: (kind: "initial" | "replacement" | "recovery") => object,
 * }>} options
 */
export function createStaffCredentialJourney(options) {
  const input = asRecord(options, "STAFF_JOURNEY_OPTIONS_INVALID");
  requireStaffJourneyApi(input.api);
  const api = input.api;
  const adminSession = requireStaffSession(input.adminSession, "STAFF_ADMIN_SESSION_INVALID");
  const approverSession = requireStaffSession(
    input.approverSession,
    "STAFF_APPROVER_SESSION_INVALID",
  );
  requireThat(adminSession.staffId !== approverSession.staffId, "ADMIN_IDENTITIES_NOT_DISTINCT");
  const approverPin = requireString(input.approverPin, "STAFF_APPROVER_PIN_INVALID");
  requireThat(/^\d{4,8}$/u.test(approverPin), "STAFF_APPROVER_PIN_INVALID");
  const identity = staffSyntheticIdentity(input.run);
  const secrets = loadSecrets(input.secretFactory ?? defaultSecretFactory);

  let state = Object.freeze({
    phase: "ready",
    cleanupUncertain: false,
    createStarted: false,
    targetStaffId: null,
    initialSession: null,
    replacementSession: null,
    recoverySession: null,
    deactivateStarted: false,
    deactivationConfirmed: false,
  });
  const update = (patch) => {
    state = Object.freeze({ ...state, ...patch });
  };

  const locate = async () => {
    const result = asRecord(
      await api.query(adminSession, "staff.access.list", {}),
      "STAFF_DIRECTORY_INVALID",
    );
    requireThat(Array.isArray(result.staff), "STAFF_DIRECTORY_INVALID");
    const matches = result.staff
      .map(staffAccessRow)
      .filter((row) => row.username === identity.username);
    requireThat(matches.length <= 1, "STAFF_USERNAME_NOT_UNIQUE");
    return matches[0] ?? null;
  };

  const mutation = async (operation, register = (value) => value) => {
    update({ cleanupUncertain: true });
    const raw = await operation();
    const registered = register(raw);
    update({ cleanupUncertain: false });
    return registered;
  };

  const r5 = (name, args) =>
    mutation(() => api.stepUp(adminSession, name, args, approverSession.staffId, approverPin));

  const complete = async (setup, secretKind) => {
    const secret = secrets[secretKind];
    return mutation(
      () =>
        api.completeStaffCredentials(adminSession, {
          credential_setup_ref: setup.setupRef,
          password: secret.password,
          pin: secret.pin,
        }),
      (value) => staffCompletionResult(value, setup.targetStaffId),
    );
  };

  const assertCreatorBound = async (setup, secretKind) => {
    const secret = secrets[secretKind];
    update({ cleanupUncertain: true });
    let rejected = false;
    try {
      await api.completeStaffCredentials(approverSession, {
        credential_setup_ref: setup.setupRef,
        password: secret.password,
        pin: secret.pin,
      });
    } catch (error) {
      requireThat(
        failureCode(error) === "REMOTE_RESOURCE_UNAVAILABLE",
        "STAFF_CREATOR_BOUNDARY_INVALID",
      );
      rejected = true;
    }
    requireThat(rejected, "STAFF_CREATOR_BOUNDARY_INVALID");
    update({ cleanupUncertain: false });
  };

  const reset = async (row) =>
    staffSetupResult(
      await r5("staff.credentials.reset", {
        target_staff_id: row.staffId,
        expected_permission_version: row.permissionVersion,
        reason: identity.reason,
      }),
      row.staffId,
    );

  const deactivate = async (targetStaffId, permissionVersion) => {
    update({ deactivateStarted: true });
    const row = staffAccessChangeResult(
      await r5("staff.access.set", {
        target_staff_id: targetStaffId,
        expected_permission_version: permissionVersion,
        role: "staff",
        privacy_admin: false,
        is_active: false,
        reason: identity.reason,
      }),
      targetStaffId,
      false,
    );
    return row;
  };

  const assertSessionRejected = async (session) => {
    if (session === null) return;
    await api.expectStaffFailure(session);
    await api.expectRefreshFailure(session);
  };

  const assertPasswordRejected = async (secretKind) => {
    await api.expectLoginFailure({
      username: identity.username,
      password: secrets[secretKind].password,
    });
  };

  const assertInactiveDirectory = async (expectedStaffId) => {
    const row = await locate();
    requireThat(
      row !== null &&
        row.staffId === expectedStaffId &&
        row.displayName === identity.displayName &&
        row.role === "staff" &&
        row.privacyAdmin === false &&
        row.isActive === false,
      "STAFF_DEACTIVATION_INVALID",
    );
    return row;
  };

  const assertAllCredentialsRejected = async () => {
    await assertSessionRejected(state.initialSession);
    await assertSessionRejected(state.replacementSession);
    await assertSessionRejected(state.recoverySession);
    for (const kind of SECRET_KINDS) await assertPasswordRejected(kind);
  };

  const execute = async () => {
    requireThat(state.phase === "ready", "STAFF_JOURNEY_ALREADY_STARTED");
    update({ phase: "running" });
    try {
      requireThat((await locate()) === null, "STAFF_USERNAME_COLLISION");
      update({ createStarted: true });
      const created = staffSetupResult(
        await r5("staff.create", {
          username: identity.username,
          display_name: identity.displayName,
          role: "staff",
          privacy_admin: false,
          reason: identity.reason,
        }),
      );
      update({ targetStaffId: created.targetStaffId });

      await assertCreatorBound(created, "initial");
      const initial = await complete(created, "initial");
      const initialSession = requireStaffSession(
        await api.login(
          {
            username: identity.username,
            displayName: identity.displayName,
            password: secrets.initial.password,
          },
          "staff",
        ),
        "STAFF_LOGIN_INVALID",
      );
      requireThat(initialSession.staffId === created.targetStaffId, "STAFF_LOGIN_INVALID");
      update({ initialSession });

      const resetSetup = await reset(
        Object.freeze({
          staffId: created.targetStaffId,
          permissionVersion: initial.permissionVersion,
        }),
      );
      await assertSessionRejected(initialSession);
      await assertPasswordRejected("initial");

      await assertCreatorBound(resetSetup, "replacement");
      const replacement = await complete(resetSetup, "replacement");
      const replacementSession = requireStaffSession(
        await api.login(
          {
            username: identity.username,
            displayName: identity.displayName,
            password: secrets.replacement.password,
          },
          "staff",
        ),
        "STAFF_LOGIN_INVALID",
      );
      requireThat(replacementSession.staffId === created.targetStaffId, "STAFF_LOGIN_INVALID");
      update({ replacementSession });

      await deactivate(created.targetStaffId, replacement.permissionVersion);
      await assertSessionRejected(replacementSession);
      await assertPasswordRejected("replacement");
      const inactive = await assertInactiveDirectory(created.targetStaffId);
      update({ phase: "complete", cleanupUncertain: false, deactivationConfirmed: true });
      return Object.freeze({
        username: identity.username,
        staffId: inactive.staffId,
        status: "deactivated",
      });
    } catch (error) {
      update({ phase: "interrupted" });
      throw error;
    }
  };

  const recoverAndDeactivate = async (row) => {
    const setup = await reset(row);
    const completed = await complete(setup, "recovery");
    const recoverySession = requireStaffSession(
      await api.login(
        {
          username: identity.username,
          displayName: identity.displayName,
          password: secrets.recovery.password,
        },
        "staff",
      ),
      "STAFF_LOGIN_INVALID",
    );
    requireThat(recoverySession.staffId === row.staffId, "STAFF_LOGIN_INVALID");
    update({ recoverySession });
    await deactivate(row.staffId, completed.permissionVersion);
    await assertAllCredentialsRejected();
    return assertInactiveDirectory(row.staffId);
  };

  const reconcileCommittedDeactivate = async () => {
    if (!state.deactivateStarted || state.targetStaffId === null) return false;
    try {
      const row = await locate();
      if (row === null || row.staffId !== state.targetStaffId || row.isActive) return false;
      await assertAllCredentialsRejected();
      await assertInactiveDirectory(row.staffId);
      update({
        phase: "cleaned",
        cleanupUncertain: false,
        targetStaffId: row.staffId,
        deactivationConfirmed: true,
      });
      return true;
    } catch {
      return false;
    }
  };

  const cleanup = async () => {
    if (state.phase === "cleanup_running") return false;
    const previousPhase = state.phase;
    update({ phase: "cleanup_running" });
    try {
      if (!state.createStarted) {
        update({ phase: "cleaned", cleanupUncertain: false });
        return true;
      }
      const row = await locate();
      if (row === null) {
        requireThat(!state.deactivationConfirmed, "STAFF_CLEANUP_TARGET_MISSING");
        update({ phase: "cleaned", cleanupUncertain: false });
        return true;
      }
      requireThat(state.targetStaffId !== null, "STAFF_CLEANUP_TARGET_UNPROVEN");
      requireThat(state.targetStaffId === row.staffId, "STAFF_CLEANUP_TARGET_INVALID");
      if (row.isActive === false && (state.deactivationConfirmed || state.deactivateStarted)) {
        await assertAllCredentialsRejected();
        await assertInactiveDirectory(row.staffId);
      } else {
        await recoverAndDeactivate(row);
      }
      update({ phase: "cleaned", cleanupUncertain: false, deactivationConfirmed: true });
      return true;
    } catch {
      update({ phase: previousPhase === "ready" ? "interrupted" : previousPhase });
      return reconcileCommittedDeactivate();
    }
  };

  requireThat(typeof identity.username === "string", "STAFF_IDENTITY_INVALID");
  return Object.freeze({ execute, cleanup });
}
