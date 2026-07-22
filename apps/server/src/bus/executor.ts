/**
 * C1 command executor.
 *
 * Flow: idempotency check → (optional confirm_ref resolve) → withTenantTransaction →
 *   chain → (consume pending) → handler + same-txn audit → after-commit events.
 *
 * Confirm / step_up: first call creates pending and fails closed; second call with
 * confirm_ref executes frozen args after CAS consume (WYSIWYS).
 */

import { createCommandError, type CommandError } from "@laundry/contracts";
import { randomUUID } from "node:crypto";

import { writeAudit, type AuditWriteRecord } from "../audit/write-audit.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { processPendingActionStore } from "../pending-actions/process-store.js";
import type { PendingAction, PendingActionStore } from "../pending-actions/types.js";
import { verifyStepUpProof } from "../policy/step-up.js";
import { processStepUpProofStore, type StepUpProofStore } from "../policy/step-up-proof-store.js";
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
  /** Defaults to process-local MemoryPendingActionStore. */
  pendingStore?: PendingActionStore;
  /** Defaults to process-local MemoryStepUpProofStore. */
  stepUpProofStore?: StepUpProofStore;
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
  const registered = opts.registry.get(name);
  if (registered === undefined) {
    return fail(createCommandError("RESOURCE_UNAVAILABLE"));
  }

  const pendingStore = opts.pendingStore ?? processPendingActionStore;
  const resolved = resolveConfirmInput(name, input, tenantCtx, opts, pendingStore);
  if (resolved.ok === false) {
    return fail(resolved.error);
  }

  const request = buildRequest(name, resolved.input, opts);
  const cached = await readIdempotentReplay(tenantCtx, request, opts.idempotencyStore);
  if (cached !== null) return cached;

  const handler = opts.handler ?? registered.handler;
  const ports = createChainPorts(registered.definition, opts.chainHooks);
  const busCtx: BusContext = Object.freeze({
    tenant: tenantCtx,
    actor: opts.actor,
    request,
    definition: registered.definition,
    ...(resolved.confirmAuthorized
      ? {
          confirmAuthorized: true as const,
          confirmAuthorization: Object.freeze({
            confirmRef: resolved.confirmRef,
            argsHash: resolved.argsHash,
          }),
        }
      : {}),
  });

  let txnOutcome: TxnBody;
  try {
    txnOutcome = await withTenantTransaction(client, tenantCtx, async (tx) =>
      runInsideTransaction(tx, busCtx, ports, handler, opts, pendingStore),
    );
  } catch (error) {
    if (error instanceof CommandBusTxnError) return fail(error.commandError);
    if (error instanceof HandlerCommandError) return fail(error.commandError);
    return fail(createCommandError("TRANSACTION_FAILED"));
  }

  await publishAfterCommit(opts.eventBus, txnOutcome.events);

  if (txnOutcome.cacheable && request.idempotencyKey !== undefined && opts.idempotencyStore) {
    await opts.idempotencyStore.put(tenantCtx, name, request.idempotencyKey, txnOutcome.result);
  }

  return txnOutcome.result;
}

type ConfirmResolve =
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

function resolveConfirmInput(
  name: string,
  input: unknown,
  tenant: TenantContext,
  opts: ExecuteCommandOptions,
  pendingStore: PendingActionStore,
): ConfirmResolve {
  if (opts.confirmRef === undefined) {
    return Object.freeze({ ok: true as const, input, confirmAuthorized: false as const });
  }

  const pending = pendingStore.get(opts.confirmRef);
  const now = Math.floor((opts.now?.() ?? new Date()).getTime() / 1000);
  const gate = validatePendingCard(pending, name, tenant, now);
  if (gate.ok === false) {
    return Object.freeze({ ok: false as const, error: gate.error });
  }

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
  if (pending === null) {
    return Object.freeze({
      ok: false as const,
      error: createCommandError("POLICY_DENIED"),
    });
  }
  if (pending.status !== "pending") {
    return Object.freeze({
      ok: false as const,
      error: createCommandError("POLICY_DENIED"),
    });
  }
  if (nowEpochSeconds >= pending.expiresAt) {
    return Object.freeze({
      ok: false as const,
      error: createCommandError("POLICY_DENIED"),
    });
  }
  if (pending.command !== commandName) {
    return Object.freeze({
      ok: false as const,
      error: createCommandError("POLICY_DENIED"),
    });
  }
  if (pending.orgId !== tenant.orgId || pending.storeId !== tenant.storeId) {
    return Object.freeze({
      ok: false as const,
      error: createCommandError("POLICY_DENIED"),
    });
  }
  return Object.freeze({ ok: true as const, pending });
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
  pendingStore: PendingActionStore,
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

  // Consume pending card after chain pass, before mutation (CAS fail-closed).
  if (busCtx.confirmAuthorization !== undefined) {
    const nowEpochSeconds = Math.floor((opts.now?.() ?? new Date()).getTime() / 1000);
    const confirmRef = busCtx.confirmAuthorization.confirmRef;
    const pending = pendingStore.get(confirmRef);
    let approverStaffId = busCtx.actor.staffId;

    // Creator resume path: active step-up proof (from other staff PIN) stands in for
    // other-approver identity. Consume proof first (single-use), then pending.
    if (
      pending !== null &&
      pending.requiresOtherApprover &&
      busCtx.actor.staffId === pending.creatorStaffId
    ) {
      const proofStore = opts.stepUpProofStore ?? processStepUpProofStore;
      const proof = proofStore.findActiveByPendingRef(confirmRef);
      if (proof === null) {
        throw new CommandBusTxnError(createCommandError("POLICY_DENIED"));
      }
      const verified = verifyStepUpProof(proof, pending, nowEpochSeconds);
      if (verified.ok === false) {
        throw new CommandBusTxnError(createCommandError("POLICY_DENIED"));
      }
      if (!proofStore.atomicConsume(proof.proofId, nowEpochSeconds)) {
        throw new CommandBusTxnError(createCommandError("POLICY_DENIED"));
      }
      approverStaffId = proof.approverStaffId;
    }

    const consume = pendingStore.atomicConsume(confirmRef, approverStaffId, {
      expectedArgsHash: busCtx.confirmAuthorization.argsHash,
      nowEpochSeconds,
    });
    if (consume.ok === false) {
      throw new CommandBusTxnError(createCommandError("POLICY_DENIED"));
    }
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
