/** Resolve a confirm_ref to its frozen, still-authorized command input. */

import { createCommandError, type CommandError } from "@laundry/contracts";

import type { SqlClient, TenantContext } from "../db/types.js";
import type { CanonicalJson, PendingAction, PendingActionStore } from "../pending-actions/types.js";
import type { CommandRequest } from "./types.js";

export type ConfirmResolve =
  | Readonly<{
      ok: true;
      input: unknown;
      confirmAuthorized: false;
    }>
  | Readonly<{
      ok: true;
      input: unknown;
      confirmAuthorized: true;
      confirmRef: string;
      argsHash: string;
      commandVersion: string;
      idempotencyKey: string;
      authority?: CanonicalJson;
    }>
  | Readonly<{ ok: false; error: CommandError }>;

type ConfirmInputOptions = Readonly<{
  confirmRef?: string;
  version?: string;
  idempotencyKey?: string;
  now?: () => Date;
}>;

export async function resolveConfirmInput(
  name: string,
  registeredVersion: string,
  input: unknown,
  tenant: TenantContext,
  opts: ConfirmInputOptions,
  pendingStore: PendingActionStore,
  client: SqlClient,
): Promise<ConfirmResolve> {
  if (opts.confirmRef === undefined) {
    return Object.freeze({ ok: true as const, input, confirmAuthorized: false as const });
  }

  const pending = await pendingStore.get(opts.confirmRef, { tenant, client });
  const now = Math.floor((opts.now?.() ?? new Date()).getTime() / 1000);
  const gate = validatePendingCard(pending, name, registeredVersion, tenant, now, opts);
  if (gate.ok === false) return Object.freeze({ ok: false as const, error: gate.error });

  return Object.freeze({
    ok: true as const,
    input: gate.pending.args,
    confirmAuthorized: true as const,
    confirmRef: opts.confirmRef,
    argsHash: gate.pending.argsHash,
    commandVersion: gate.pending.commandVersion,
    idempotencyKey: gate.pending.idempotencyKey,
    ...(gate.pending.authority === undefined ? {} : { authority: gate.pending.authority }),
  });
}

type RequestOptions = Readonly<{
  version?: string;
  dryRun?: boolean;
  idempotencyKey?: string;
  confirmRef?: string;
}>;

/** Build a request whose confirmation version/idempotency come from server authority. */
export function buildResolvedCommandRequest(
  name: string,
  input: unknown,
  options: RequestOptions,
  resolved: Extract<ConfirmResolve, { ok: true }>,
): CommandRequest {
  const version = resolved.confirmAuthorized
    ? resolved.commandVersion
    : (options.version ?? "1.0.0");
  const idempotencyKey = resolved.confirmAuthorized
    ? resolved.idempotencyKey
    : options.idempotencyKey;
  return Object.freeze({
    name,
    version,
    input,
    dryRun: options.dryRun === true,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(options.confirmRef === undefined ? {} : { confirmRef: options.confirmRef }),
  });
}

function validatePendingCard(
  pending: PendingAction | null,
  commandName: string,
  registeredVersion: string,
  tenant: TenantContext,
  nowEpochSeconds: number,
  options: ConfirmInputOptions,
): Readonly<{ ok: true; pending: PendingAction }> | Readonly<{ ok: false; error: CommandError }> {
  if (
    pending === null ||
    (pending.status !== "pending" && pending.status !== "consumed") ||
    (pending.status === "pending" && nowEpochSeconds >= pending.expiresAt) ||
    pending.command !== commandName ||
    pending.commandVersion !== registeredVersion ||
    pending.orgId !== tenant.orgId ||
    pending.storeId !== tenant.storeId ||
    pending.creatorStaffId !== tenant.staffId ||
    (options.version !== undefined && options.version !== pending.commandVersion) ||
    (options.idempotencyKey !== undefined && options.idempotencyKey !== pending.idempotencyKey)
  ) {
    return Object.freeze({ ok: false as const, error: createCommandError("POLICY_DENIED") });
  }
  return Object.freeze({ ok: true as const, pending });
}
