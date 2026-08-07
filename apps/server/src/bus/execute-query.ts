/**
 * Read-only query executor (M1 platform queries).
 *
 * Flow: load definition → Zod parse → withTenantTransaction → handler.
 * No audit write, no idempotency, no dry_run mutation path.
 * Still runs under tenant GUCs so RLS applies to SELECT.
 */

import { createCommandError, parseContractInput, type CommandError } from "@laundry/contracts";

import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import type { ActorContext, CommandHandler, CommandResult, HandlerCommandError } from "./types.js";
import { HandlerCommandError as HandlerCmdErr } from "./types.js";
import type { QueryRegistry } from "./query-registry.js";
import { actorHasInvariantPermissions } from "./rbac.js";
import { validationErrorFrom } from "./validation-error.js";

export type ExecuteQueryOptions = Readonly<{
  actor: ActorContext;
  registry: QueryRegistry;
  version?: string;
  /** Optional override (tests). */
  handler?: CommandHandler;
  /** HTTP boundary hook for private diagnostics; never enters the public envelope. */
  onUnexpectedError?: (error: unknown) => void;
}>;

function fail(error: CommandError): CommandResult {
  return Object.freeze({ ok: false as const, error });
}

function executed(result: unknown): CommandResult {
  return Object.freeze({
    ok: true as const,
    data: Object.freeze({
      execution: "executed" as const,
      result,
    }),
  });
}

/**
 * Execute one named query under tenant GUC transaction (read path).
 */
export async function executeQuery(
  client: SqlClient,
  tenantCtx: TenantContext,
  name: string,
  input: unknown,
  opts: ExecuteQueryOptions,
): Promise<CommandResult> {
  const registered = opts.registry.get(name);
  if (registered === undefined) {
    return fail(createCommandError("RESOURCE_UNAVAILABLE"));
  }

  const handler = opts.handler ?? registered.handler;
  if (handler === undefined) {
    return fail(createCommandError("RESOURCE_UNAVAILABLE"));
  }
  if (!actorHasInvariantPermissions(opts.actor, registered.definition.invariants)) {
    return fail(createCommandError("PERMISSION_DENIED"));
  }

  let parsed: unknown;
  try {
    parsed = await parseContractInput(registered.definition, input);
  } catch (error) {
    return fail(validationErrorFrom(error));
  }

  const request = Object.freeze({
    name,
    version: opts.version ?? registered.definition.version,
    input,
    dryRun: false as const,
  });

  try {
    const outcome = await withTenantTransaction(
      client,
      tenantCtx,
      async (tx) =>
        handler({
          client: tx,
          tenant: tenantCtx,
          actor: opts.actor,
          request,
          parsed,
        }),
      { isolation: "repeatable_read", readOnly: true },
    );
    return executed(outcome.result);
  } catch (error) {
    if (error instanceof HandlerCmdErr) {
      return fail(error.commandError);
    }
    opts.onUnexpectedError?.(error);
    return fail(createCommandError("TRANSACTION_FAILED"));
  }
}

export type { HandlerCommandError };
