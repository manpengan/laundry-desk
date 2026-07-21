/**
 * C1 command executor.
 *
 * Flow: idempotency check → withTenantTransaction → chain →
 *   (dry_run ? preview : handler + same-txn audit) → after-commit events.
 */

import { createCommandError, type CommandError } from "@laundry/contracts";
import { randomUUID } from "node:crypto";

import { writeAudit, type AuditWriteRecord } from "../audit/write-audit.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import {
  chainFailureToResult,
  createChainPorts,
  runCommandChain,
  type BusChainData,
  type ChainPortHooks,
} from "./chain-adapter.js";
import type {
  ActorContext,
  AuditWriteInput,
  BusContext,
  CommandHandler,
  CommandRegistry,
  CommandRequest,
  CommandResult,
  DomainEvent,
  EventBus,
  HandlerOutcome,
  IdempotencyStore,
} from "./types.js";
import { HandlerCommandError } from "./types.js";

export type ExecuteCommandOptions = Readonly<{
  actor: ActorContext;
  registry: CommandRegistry;
  version?: string;
  dryRun?: boolean;
  idempotencyKey?: string;
  confirmRef?: string;
  chainHooks?: ChainPortHooks;
  handler?: CommandHandler;
  eventBus?: EventBus;
  idempotencyStore?: IdempotencyStore;
  now?: () => Date;
  newId?: () => string;
}>;

type TxnBody = Readonly<{
  result: CommandResult;
  events: readonly DomainEvent[];
  cacheable: boolean;
}>;

/**
 * Execute one named command under tenant GUC transaction.
 * Routes / AI / workers must call this (or a thin wrapper) — never write repos directly.
 */
export async function executeCommand(
  client: SqlClient,
  tenantCtx: TenantContext,
  name: string,
  input: unknown,
  opts: ExecuteCommandOptions,
): Promise<CommandResult> {
  const request = buildRequest(name, input, opts);
  const registered = opts.registry.get(name);
  if (registered === undefined) {
    return fail(createCommandError("RESOURCE_UNAVAILABLE"));
  }

  const cached = await readIdempotentReplay(tenantCtx, request, opts.idempotencyStore);
  if (cached !== null) return cached;

  const handler = opts.handler ?? registered.handler;
  const ports = createChainPorts(registered.definition, opts.chainHooks);
  const busCtx: BusContext = Object.freeze({
    tenant: tenantCtx,
    actor: opts.actor,
    request,
    definition: registered.definition,
  });

  let txnOutcome: TxnBody;
  try {
    txnOutcome = await withTenantTransaction(client, tenantCtx, async (tx) =>
      runInsideTransaction(tx, busCtx, ports, handler, opts),
    );
  } catch (error) {
    if (error instanceof CommandBusTxnError) return fail(error.commandError);
    if (error instanceof HandlerCommandError) return fail(error.commandError);
    // Handler / audit failure already rolled back via withTenantTransaction.
    return fail(createCommandError("TRANSACTION_FAILED"));
  }

  await publishAfterCommit(opts.eventBus, txnOutcome.events);

  if (txnOutcome.cacheable && request.idempotencyKey !== undefined && opts.idempotencyStore) {
    await opts.idempotencyStore.put(tenantCtx, name, request.idempotencyKey, txnOutcome.result);
  }

  return txnOutcome.result;
}

function buildRequest(name: string, input: unknown, opts: ExecuteCommandOptions): CommandRequest {
  const base = {
    name,
    version: opts.version ?? "1.0.0",
    input,
    dryRun: opts.dryRun === true,
  };
  return Object.freeze({
    ...base,
    ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
    ...(opts.confirmRef !== undefined ? { confirmRef: opts.confirmRef } : {}),
  });
}

async function readIdempotentReplay(
  tenant: TenantContext,
  request: CommandRequest,
  store: IdempotencyStore | undefined,
): Promise<CommandResult | null> {
  if (store === undefined || request.idempotencyKey === undefined) return null;
  return store.get(tenant, request.name, request.idempotencyKey);
}

async function runInsideTransaction(
  tx: SqlClient,
  busCtx: BusContext,
  ports: ReturnType<typeof createChainPorts>,
  handler: CommandHandler | undefined,
  opts: ExecuteCommandOptions,
): Promise<TxnBody> {
  const chain = await runCommandChain(busCtx, busCtx.request.input, ports);
  if (chain.ok === false) {
    return {
      result: fail(chainFailureToResult(chain)),
      events: Object.freeze([]),
      cacheable: false,
    };
  }

  if (busCtx.request.dryRun) {
    return {
      result: preview(chain.data),
      events: Object.freeze([]),
      cacheable: false,
    };
  }

  if (handler === undefined) {
    throw new CommandBusTxnError(createCommandError("RESOURCE_UNAVAILABLE"));
  }

  const outcome = await handler({
    client: tx,
    tenant: busCtx.tenant,
    actor: busCtx.actor,
    request: busCtx.request,
    parsed: chain.data.parsed,
  });

  await writeAuditForOutcome(tx, busCtx, outcome.audit, opts);

  return {
    result: executed(outcome.result),
    events: Object.freeze([...(outcome.events ?? [])]),
    cacheable: true,
  };
}

async function writeAuditForOutcome(
  tx: SqlClient,
  busCtx: BusContext,
  audit: AuditWriteInput | undefined,
  opts: ExecuteCommandOptions,
): Promise<void> {
  const now = opts.now ?? (() => new Date());
  const newId = opts.newId ?? (() => randomUUID());
  const record: AuditWriteRecord = {
    id: newId(),
    orgId: busCtx.tenant.orgId,
    storeId: busCtx.tenant.storeId,
    staffId: busCtx.actor.staffId,
    via: busCtx.actor.via,
    command: busCtx.request.name,
    idempotencyKey: busCtx.request.idempotencyKey ?? null,
    dryRun: false,
    entity: audit?.entity ?? null,
    entityId: audit?.entityId ?? null,
    beforeJson: audit?.beforeJson ?? null,
    afterJson: audit?.afterJson ?? null,
    ip: audit?.ip ?? null,
    deviceId: busCtx.actor.deviceId,
    at: now(),
  };
  await writeAudit(tx, record);
}

async function publishAfterCommit(
  eventBus: EventBus | undefined,
  events: readonly DomainEvent[],
): Promise<void> {
  if (eventBus === undefined || events.length === 0) return;
  await eventBus.publish(events);
}

function preview(data: BusChainData): CommandResult {
  return Object.freeze({
    ok: true as const,
    data: Object.freeze({
      execution: "preview" as const,
      result: Object.freeze({
        parsed: data.parsed,
        policy: data.policy,
        invariants: data.invariants,
      }),
    }),
  });
}

function executed(result: unknown): CommandResult {
  return Object.freeze({
    ok: true as const,
    data: Object.freeze({ execution: "executed" as const, result }),
  });
}

function fail(error: CommandError): CommandResult {
  return Object.freeze({ ok: false as const, error });
}

/** Internal: convert post-chain hard failures into CommandResult without leaking stack. */
class CommandBusTxnError extends Error {
  readonly commandError: CommandError;

  constructor(commandError: CommandError) {
    super(commandError.message);
    this.name = "CommandBusTxnError";
    this.commandError = commandError;
  }
}

export type { HandlerOutcome };
