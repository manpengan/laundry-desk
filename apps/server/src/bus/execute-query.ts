/**
 * Read-only query executor (M1 platform queries).
 *
 * Flow: load definition → Zod parse → withTenantTransaction → handler.
 * No audit write, no idempotency, no dry_run mutation path.
 * Still runs under tenant GUCs so RLS applies to SELECT.
 */

import { createCommandError, parseContractInput, type CommandError } from "@laundry/contracts";
import { ZodError } from "zod";

import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import type { ActorContext, CommandHandler, CommandResult, HandlerCommandError } from "./types.js";
import { HandlerCommandError as HandlerCmdErr } from "./types.js";
import type { QueryRegistry } from "./query-registry.js";

export type ExecuteQueryOptions = Readonly<{
  actor: ActorContext;
  registry: QueryRegistry;
  version?: string;
  /** Optional override (tests). */
  handler?: CommandHandler;
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

function toValidationError(error: unknown): CommandError {
  if (error instanceof ZodError) {
    const first = error.issues[0];
    const path =
      first === undefined || first.path.length === 0 ? "/" : `/${first.path.map(String).join("/")}`;
    return createCommandError("VALIDATION_FAILED", { kind: "field", path });
  }
  return createCommandError("VALIDATION_FAILED");
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

  let parsed: unknown;
  try {
    parsed = await parseContractInput(registered.definition, input);
  } catch (error) {
    return fail(toValidationError(error));
  }

  const request = Object.freeze({
    name,
    version: opts.version ?? registered.definition.version,
    input,
    dryRun: false as const,
  });

  try {
    const outcome = await withTenantTransaction(client, tenantCtx, async (tx) =>
      handler({
        client: tx,
        tenant: tenantCtx,
        actor: opts.actor,
        request,
        parsed,
      }),
    );
    return executed(outcome.result);
  } catch (error) {
    if (error instanceof HandlerCmdErr) {
      return fail(error.commandError);
    }
    return fail(createCommandError("TRANSACTION_FAILED"));
  }
}

export type { HandlerCommandError };
