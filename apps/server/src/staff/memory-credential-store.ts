import type { StaffRecord } from "../identity/types.js";
import type { MemoryStaffAccessState, StaffAccessRow } from "./access-store.js";
import type {
  MemoryCredentialIdentityAdapter,
  StaffCredentialComplete,
  StaffCredentialIssue,
  StaffCredentialMutationResult,
  StaffCredentialSetupResult,
  StaffCredentialStore,
  StaffCreate,
  StaffCredentialReset,
  StaffRole,
} from "./credential-types.js";

const PENDING_PASSWORD_HASH = "!laundry-credential-pending";

type MemorySetup = Readonly<{
  id: string;
  targetStaffId: string;
  creatorStaffId: string;
  purpose: "create" | "reset";
  role: StaffRole;
  privacyAdmin: boolean;
  targetPermissionVersion: number;
  expiresAt: number;
  status: "pending" | "consumed" | "expired";
}>;

const setupResult = (issue: StaffCredentialIssue): StaffCredentialSetupResult =>
  Object.freeze({
    credential_setup_ref: issue.setupRef,
    target_staff_id: issue.targetStaffId,
    expires_at: issue.expiresAt,
    status: "pending" as const,
  });

function replaceRow(
  state: MemoryStaffAccessState,
  targetStaffId: string,
  replacement: StaffAccessRow,
): void {
  state.replace(state.read().map((row) => (row.staff_id === targetStaffId ? replacement : row)));
}

function hasActiveAdmin(state: MemoryStaffAccessState, staffId: string): boolean {
  return state
    .read()
    .some((row) => row.staff_id === staffId && row.is_active && row.role === "admin");
}

function authorityFailure(
  rows: readonly StaffAccessRow[],
  target: StaffAccessRow,
): "last_admin" | "last_privacy_admin" | null {
  const others = rows.filter((row) => row.staff_id !== target.staff_id && row.is_active);
  if (target.role === "admin" && !others.some((row) => row.role === "admin")) {
    return "last_admin";
  }
  if (target.privacy_admin && !others.some((row) => row.privacy_admin)) {
    return "last_privacy_admin";
  }
  return null;
}

function inactiveIdentity(
  row: StaffAccessRow,
  current: StaffRecord | null,
  orgId: string,
  passwordHash: string,
  pinHash: string | null,
): StaffRecord {
  return Object.freeze({
    staff_id: row.staff_id,
    org_id: current?.org_id ?? orgId,
    username: row.username,
    password_hash: passwordHash,
    pin_hash: pinHash,
    display_name: row.display_name,
    is_active: false,
    permission_version: row.permission_version,
  });
}

export function createMemoryStaffCredentialStore(
  state: MemoryStaffAccessState,
  identity: MemoryCredentialIdentityAdapter,
): StaffCredentialStore {
  let setups: readonly MemorySetup[] = Object.freeze([]);

  const create = async (
    actorStaffId: string,
    input: StaffCreate,
    issue: StaffCredentialIssue,
  ): Promise<StaffCredentialMutationResult> => {
    if (!hasActiveAdmin(state, actorStaffId)) {
      return Object.freeze({ ok: false as const, reason: "not_found" as const });
    }
    if (state.read().some((row) => row.username === input.username)) {
      return Object.freeze({ ok: false as const, reason: "duplicate_username" as const });
    }
    const after: StaffAccessRow = Object.freeze({
      staff_id: issue.targetStaffId,
      username: input.username,
      display_name: input.display_name,
      role: input.role,
      privacy_admin: false,
      is_active: false,
      permission_version: 1,
    });
    state.replace([...state.read(), after]);
    state.markCredentialPending(after.staff_id);
    identity.upsertStaff(
      inactiveIdentity(after, null, identity.orgId, PENDING_PASSWORD_HASH, null),
    );
    setups = Object.freeze([
      ...setups,
      Object.freeze({
        id: issue.setupRef,
        targetStaffId: issue.targetStaffId,
        creatorStaffId: actorStaffId,
        purpose: "create" as const,
        role: input.role,
        privacyAdmin: input.privacy_admin,
        targetPermissionVersion: 1,
        expiresAt: issue.expiresAt,
        status: "pending" as const,
      }),
    ]);
    return Object.freeze({ ok: true as const, setup: setupResult(issue), after });
  };

  const reset = async (
    actorStaffId: string,
    input: StaffCredentialReset,
    issue: StaffCredentialIssue,
  ): Promise<StaffCredentialMutationResult> => {
    if (actorStaffId === input.target_staff_id) {
      return Object.freeze({ ok: false as const, reason: "self_change" as const });
    }
    if (!hasActiveAdmin(state, actorStaffId)) {
      return Object.freeze({ ok: false as const, reason: "not_found" as const });
    }
    const before = state.read().find((row) => row.staff_id === input.target_staff_id);
    if (before === undefined)
      return Object.freeze({ ok: false as const, reason: "not_found" as const });
    if (before.permission_version !== input.expected_permission_version) {
      return Object.freeze({ ok: false as const, reason: "stale" as const });
    }
    if (!before.is_active) {
      const previous = [...setups]
        .reverse()
        .find(
          (row) =>
            row.targetStaffId === before.staff_id &&
            (row.status === "pending" || row.status === "expired"),
        );
      if (
        previous === undefined ||
        previous.targetPermissionVersion !== before.permission_version
      ) {
        return Object.freeze({ ok: false as const, reason: "inactive" as const });
      }
      setups = Object.freeze([
        ...setups.map((row) =>
          row.id === previous.id && row.status === "pending"
            ? Object.freeze({ ...row, status: "expired" as const })
            : row,
        ),
        Object.freeze({
          id: issue.setupRef,
          targetStaffId: before.staff_id,
          creatorStaffId: actorStaffId,
          purpose: "reset" as const,
          role: previous.role,
          privacyAdmin: previous.privacyAdmin,
          targetPermissionVersion: before.permission_version,
          expiresAt: issue.expiresAt,
          status: "pending" as const,
        }),
      ]);
      return Object.freeze({
        ok: true as const,
        setup: setupResult(issue),
        before,
        after: before,
      });
    }
    const authority = authorityFailure(state.read(), before);
    if (authority !== null) return Object.freeze({ ok: false as const, reason: authority });
    if (setups.some((row) => row.targetStaffId === before.staff_id && row.status === "pending")) {
      return Object.freeze({ ok: false as const, reason: "setup_pending" as const });
    }
    const after = Object.freeze({
      ...before,
      privacy_admin: false,
      is_active: false,
      permission_version: before.permission_version + 1,
    });
    replaceRow(state, before.staff_id, after);
    state.markCredentialPending(before.staff_id);
    const current = await identity.findStaff(before.staff_id);
    identity.upsertStaff(
      inactiveIdentity(after, current, identity.orgId, PENDING_PASSWORD_HASH, null),
    );
    await identity.revokeSessions(before.staff_id, issue.createdAt);
    setups = Object.freeze([
      ...setups,
      Object.freeze({
        id: issue.setupRef,
        targetStaffId: before.staff_id,
        creatorStaffId: actorStaffId,
        purpose: "reset" as const,
        role: before.role,
        privacyAdmin: before.privacy_admin,
        targetPermissionVersion: after.permission_version,
        expiresAt: issue.expiresAt,
        status: "pending" as const,
      }),
    ]);
    return Object.freeze({ ok: true as const, setup: setupResult(issue), before, after });
  };

  const complete = async (actorStaffId: string, input: StaffCredentialComplete) => {
    const setup = setups.find((row) => row.id === input.credential_setup_ref);
    const target =
      setup === undefined
        ? undefined
        : state.read().find((row) => row.staff_id === setup.targetStaffId);
    if (
      setup === undefined ||
      target === undefined ||
      setup.creatorStaffId !== actorStaffId ||
      setup.status !== "pending" ||
      setup.expiresAt <= input.now ||
      target.is_active ||
      target.permission_version !== setup.targetPermissionVersion ||
      !hasActiveAdmin(state, actorStaffId)
    ) {
      if (setup?.status === "pending" && setup.expiresAt <= input.now) {
        setups = Object.freeze(
          setups.map((row) =>
            row.id === setup.id ? Object.freeze({ ...row, status: "expired" as const }) : row,
          ),
        );
      }
      return Object.freeze({ ok: false as const });
    }
    const active = Object.freeze({
      ...target,
      role: setup.role,
      privacy_admin: setup.privacyAdmin,
      is_active: true,
      permission_version: target.permission_version + 1,
    });
    replaceRow(state, target.staff_id, active);
    state.clearCredentialPending(target.staff_id);
    const current = await identity.findStaff(target.staff_id);
    identity.upsertStaff(
      Object.freeze({
        ...inactiveIdentity(active, current, identity.orgId, input.password_hash, input.pin_hash),
        is_active: true,
      }),
    );
    setups = Object.freeze(
      setups.map((row) =>
        row.id === setup.id ? Object.freeze({ ...row, status: "consumed" as const }) : row,
      ),
    );
    return Object.freeze({
      ok: true as const,
      result: Object.freeze({
        target_staff_id: active.staff_id,
        permission_version: active.permission_version,
        status: "active" as const,
      }),
    });
  };

  return Object.freeze({ create, reset, complete });
}
