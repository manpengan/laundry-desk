/** Resolve a confirm_ref to its frozen, still-authorized command input. */

import { createCommandError, type CommandError } from "@laundry/contracts";

import type { TenantContext } from "../db/types.js";
import type { PendingAction, PendingActionStore } from "../pending-actions/types.js";

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
    }>
  | Readonly<{ ok: false; error: CommandError }>;

type ConfirmInputOptions = Readonly<{
  confirmRef?: string;
  now?: () => Date;
}>;

export function resolveConfirmInput(
  name: string,
  input: unknown,
  tenant: TenantContext,
  opts: ConfirmInputOptions,
  pendingStore: PendingActionStore,
): ConfirmResolve {
  if (opts.confirmRef === undefined) {
    return Object.freeze({ ok: true as const, input, confirmAuthorized: false as const });
  }

  const pending = pendingStore.get(opts.confirmRef);
  const now = Math.floor((opts.now?.() ?? new Date()).getTime() / 1000);
  const gate = validatePendingCard(pending, name, tenant, now);
  if (gate.ok === false) return Object.freeze({ ok: false as const, error: gate.error });

  return Object.freeze({
    ok: true as const,
    input: gate.pending.args,
    confirmAuthorized: true as const,
    confirmRef: opts.confirmRef,
    argsHash: gate.pending.argsHash,
  });
}

function validatePendingCard(
  pending: PendingAction | null,
  commandName: string,
  tenant: TenantContext,
  nowEpochSeconds: number,
): Readonly<{ ok: true; pending: PendingAction }> | Readonly<{ ok: false; error: CommandError }> {
  if (
    pending === null ||
    pending.status !== "pending" ||
    nowEpochSeconds >= pending.expiresAt ||
    pending.command !== commandName ||
    pending.orgId !== tenant.orgId ||
    pending.storeId !== tenant.storeId
  ) {
    return Object.freeze({ ok: false as const, error: createCommandError("POLICY_DENIED") });
  }
  return Object.freeze({ ok: true as const, pending });
}
