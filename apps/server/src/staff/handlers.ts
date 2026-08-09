import { randomUUID } from "node:crypto";

import {
  createCommandError,
  StaffCreateInputSchema,
  StaffCredentialsResetInputSchema,
} from "@laundry/contracts";

import { HandlerCommandError, type CommandHandler, type HandlerOutcome } from "../bus/types.js";
import type { MutableCommandRegistry } from "../bus/registry.js";
import type { MutableQueryRegistry } from "../bus/query-registry.js";
import {
  createSqlStaffAccessStore,
  type StaffAccessChange,
  type StaffAccessStore,
} from "./access-store.js";
import {
  STAFF_CREDENTIAL_SETUP_TTL_SECONDS,
  type StaffCredentialStore,
} from "./credential-types.js";
import { createSqlStaffCredentialStore } from "./sql-credential-store.js";

export type StaffAccessHandlerDeps = Readonly<{
  persistence?: "memory" | "sql";
  store: StaffAccessStore;
  credentials: StaffCredentialStore;
  nowEpochSeconds?: () => number;
  newId?: () => string;
}>;

function hasPermission(permissions: readonly string[] | undefined, permission: string): boolean {
  return permissions?.includes(permission) === true;
}

function requireAccessPermission(permissions: readonly string[] | undefined): void {
  if (!hasPermission(permissions, "staff_write")) {
    throw new HandlerCommandError(createCommandError("PERMISSION_DENIED"));
  }
}

function inputRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value as Readonly<Record<string, unknown>>;
}

function accessChange(value: unknown): StaffAccessChange & Readonly<{ reason: string }> {
  const input = inputRecord(value);
  if (
    typeof input.target_staff_id !== "string" ||
    typeof input.expected_permission_version !== "number" ||
    (input.role !== "admin" && input.role !== "staff") ||
    typeof input.privacy_admin !== "boolean" ||
    typeof input.is_active !== "boolean" ||
    typeof input.reason !== "string"
  ) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return Object.freeze({
    target_staff_id: input.target_staff_id,
    expected_permission_version: input.expected_permission_version,
    role: input.role,
    privacy_admin: input.privacy_admin,
    is_active: input.is_active,
    reason: input.reason.trim(),
  });
}

function resolveStore(
  deps: StaffAccessHandlerDeps,
  context: Parameters<CommandHandler>[0],
): StaffAccessStore {
  return deps.persistence === "sql"
    ? createSqlStaffAccessStore(context.client, context.tenant)
    : deps.store;
}

function resolveCredentialStore(
  deps: StaffAccessHandlerDeps,
  context: Parameters<CommandHandler>[0],
): StaffCredentialStore {
  return deps.persistence === "sql"
    ? createSqlStaffCredentialStore(context.client, context.tenant)
    : deps.credentials;
}

function credentialIssue(deps: StaffAccessHandlerDeps, targetStaffId?: string) {
  const now = deps.nowEpochSeconds?.() ?? Math.floor(Date.now() / 1_000);
  const newId = deps.newId ?? randomUUID;
  return Object.freeze({
    setupRef: newId(),
    targetStaffId: targetStaffId ?? newId(),
    roleRowId: newId(),
    createdAt: now,
    expiresAt: now + STAFF_CREDENTIAL_SETUP_TTL_SECONDS,
  });
}

function mutationError(reason: string): HandlerCommandError {
  return new HandlerCommandError(
    createCommandError(reason === "stale" ? "IDEMPOTENCY_CONFLICT" : "INVARIANT_FAILED"),
  );
}

export function createStaffAccessHandlers(
  deps: StaffAccessHandlerDeps,
): Readonly<
  Record<
    "staff.access.list" | "staff.access.set" | "staff.create" | "staff.credentials.reset",
    CommandHandler
  >
> {
  const list: CommandHandler = async (context): Promise<HandlerOutcome> => {
    requireAccessPermission(context.actor.permissions);
    const staff = await resolveStore(deps, context).list();
    return Object.freeze({ result: Object.freeze({ staff }) });
  };

  const set: CommandHandler = async (context): Promise<HandlerOutcome> => {
    requireAccessPermission(context.actor.permissions);
    const input = accessChange(context.parsed);
    const changed = await resolveStore(deps, context).set(context.actor.staffId, input);
    if (!changed.ok) {
      throw new HandlerCommandError(
        createCommandError(
          changed.reason === "stale" ? "IDEMPOTENCY_CONFLICT" : "INVARIANT_FAILED",
        ),
      );
    }
    return Object.freeze({
      result: Object.freeze({ staff: changed.after }),
      audit: Object.freeze({
        entity: "staff_access",
        entityId: changed.after.staff_id,
        beforeJson: JSON.stringify(changed.before),
        afterJson: JSON.stringify(Object.freeze({ ...changed.after, reason: input.reason })),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "staff.access_changed",
          payload: Object.freeze({
            staff_id: changed.after.staff_id,
            permission_version: changed.after.permission_version,
          }),
        }),
      ]),
    });
  };

  const create: CommandHandler = async (context): Promise<HandlerOutcome> => {
    requireAccessPermission(context.actor.permissions);
    const parsed = StaffCreateInputSchema.safeParse(context.parsed);
    if (!parsed.success) throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    const issue = credentialIssue(deps);
    const created = await resolveCredentialStore(deps, context).create(
      context.actor.staffId,
      parsed.data,
      issue,
    );
    if (!created.ok) throw mutationError(created.reason);
    return Object.freeze({
      result: created.setup,
      audit: Object.freeze({
        entity: "staff_credentials",
        entityId: created.after.staff_id,
        afterJson: JSON.stringify({
          staff_id: created.after.staff_id,
          username: created.after.username,
          display_name: created.after.display_name,
          role: parsed.data.role,
          privacy_admin: parsed.data.privacy_admin,
          status: "credential_pending",
          reason: parsed.data.reason,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "staff.created_inactive",
          payload: Object.freeze({ staff_id: created.after.staff_id }),
        }),
      ]),
    });
  };

  const reset: CommandHandler = async (context): Promise<HandlerOutcome> => {
    requireAccessPermission(context.actor.permissions);
    const parsed = StaffCredentialsResetInputSchema.safeParse(context.parsed);
    if (!parsed.success) throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    const issue = credentialIssue(deps, parsed.data.target_staff_id);
    const changed = await resolveCredentialStore(deps, context).reset(
      context.actor.staffId,
      parsed.data,
      issue,
    );
    if (!changed.ok) throw mutationError(changed.reason);
    return Object.freeze({
      result: changed.setup,
      audit: Object.freeze({
        entity: "staff_credentials",
        entityId: changed.after.staff_id,
        ...(changed.before === undefined ? {} : { beforeJson: JSON.stringify(changed.before) }),
        afterJson: JSON.stringify({
          staff_id: changed.after.staff_id,
          permission_version: changed.after.permission_version,
          status: "credential_pending",
          reason: parsed.data.reason,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "staff.credentials_invalidated",
          payload: Object.freeze({
            staff_id: changed.after.staff_id,
            permission_version: changed.after.permission_version,
          }),
        }),
      ]),
    });
  };
  return Object.freeze({
    "staff.access.list": list,
    "staff.access.set": set,
    "staff.create": create,
    "staff.credentials.reset": reset,
  });
}

export function registerStaffAccessHandlers(
  commandRegistry: MutableCommandRegistry,
  queryRegistry: MutableQueryRegistry | null,
  deps: StaffAccessHandlerDeps,
): void {
  const handlers = createStaffAccessHandlers(deps);
  commandRegistry.registerHandler("staff.access.set", handlers["staff.access.set"]);
  commandRegistry.registerHandler("staff.create", handlers["staff.create"]);
  commandRegistry.registerHandler("staff.credentials.reset", handlers["staff.credentials.reset"]);
  queryRegistry?.registerHandler("staff.access.list", handlers["staff.access.list"]);
}
