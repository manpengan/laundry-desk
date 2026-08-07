/** C1 command executor with transactional confirmation, audit, and idempotency. */

import { createCommandError, type CommandError } from "@laundry/contracts";

import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { processPendingActionStore } from "../pending-actions/process-store.js";
import type { PendingActionStore } from "../pending-actions/types.js";
import { verifyStepUpProof, type StepUpSessionBinding } from "../policy/step-up.js";
import { processStepUpProofStore, type StepUpProofStore } from "../policy/step-up-proof-store.js";
import {
  chainFailureToResult,
  createChainPorts,
  runCommandChain,
  type BusChainData,
  type ChainPortHooks,
} from "./chain-adapter.js";
import { writeAuditForOutcome, type ApprovalAuditEvidence } from "./audit-outcome.js";
import { buildResolvedCommandRequest, resolveConfirmInput } from "./confirm-input.js";
import {
  asTransactionalIdempotencyStore,
  durableLookupResult,
  hashIdempotencyRequest,
  readReplayCandidate,
} from "./durable-idempotency.js";
import { bindTransactionClient, createHandlerContext } from "./handler-context.js";
import type {
  ActorContext,
  BusContext,
  CommandHandler,
  CommandIdempotencyStore,
  CommandRegistry,
  CommandRequest,
  CommandResult,
  CommandTransactionGuard,
  DomainEvent,
  EventBus,
  HandlerOutcome,
  IdempotencyStore,
  TransactionalIdempotencyStore,
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
  idempotencyStore?: CommandIdempotencyStore;
  /** Defaults to process-local MemoryPendingActionStore. */
  pendingStore?: PendingActionStore;
  /** Defaults to process-local MemoryStepUpProofStore. */
  stepUpProofStore?: StepUpProofStore;
  /** Current authenticated session; required when consuming a step-up proof. */
  sessionBinding?: StepUpSessionBinding;
  /** Trusted server-side authority that participates in the command transaction. */
  transactionGuard?: CommandTransactionGuard;
  /** Private boundary diagnostics; never copy the error into the public command envelope. */
  onUnexpectedError?: (error: unknown) => void;
  now?: () => Date;
  newId?: () => string;
}>;

type TxnBody = Readonly<{
  result: CommandResult;
  events: readonly DomainEvent[];
  cacheable: boolean;
}>;

type TxnOutcome = TxnBody & Readonly<{ request: CommandRequest }>;

const REPEATABLE_READ_COMMANDS: ReadonlySet<string> = new Set([
  "reconciliation.export",
  "print.ticket.enqueue",
]);

/**
 * Execute one named command under tenant GUC transaction.
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
  const durableIdempotency = asTransactionalIdempotencyStore(opts.idempotencyStore);
  const handler = opts.handler ?? registered.handler;
  const ports = createChainPorts(registered.definition, opts.chainHooks);

  let txnOutcome: TxnOutcome;
  try {
    txnOutcome = await withTenantTransaction(
      client,
      tenantCtx,
      async (tx) => {
        const resolved = await resolveConfirmInput(
          name,
          registered.definition.version,
          input,
          tenantCtx,
          opts,
          pendingStore,
          tx,
        );
        if (resolved.ok === false) throw new CommandBusTxnError(resolved.error);

        const request = buildResolvedCommandRequest(name, resolved.input, opts, resolved);
        if (resolved.confirmAuthorized && request.dryRun) {
          throw new CommandBusTxnError(createCommandError("VALIDATION_FAILED"));
        }
        const requestHash =
          durableIdempotency !== null && request.idempotencyKey !== undefined
            ? hashIdempotencyRequest(
                request,
                resolved.confirmAuthorized ? resolved.argsHash : undefined,
              )
            : undefined;
        const replay =
          opts.transactionGuard === undefined
            ? await readReplayCandidate(
                tenantCtx,
                request,
                opts.idempotencyStore,
                durableIdempotency,
                requestHash,
              )
            : null;
        const busCtx: BusContext = Object.freeze({
          tenant: tenantCtx,
          actor: opts.actor,
          request,
          definition: registered.definition,
          ...(replay === null ? {} : { idempotentReplay: true as const }),
          ...(resolved.confirmAuthorized
            ? {
                confirmAuthorized: true as const,
                confirmAuthorization: Object.freeze({
                  confirmRef: resolved.confirmRef,
                  argsHash: resolved.argsHash,
                  ...(resolved.authority === undefined ? {} : { authority: resolved.authority }),
                }),
              }
            : {}),
        });
        const outcome = await runInsideTransaction(
          tx,
          busCtx,
          ports,
          handler,
          opts,
          pendingStore,
          durableIdempotency,
          requestHash,
          replay,
        );
        return Object.freeze({ ...outcome, request });
      },
      REPEATABLE_READ_COMMANDS.has(name) ? { isolation: "repeatable_read" } : {},
    );
  } catch (error) {
    if (error instanceof CommandBusTxnError) return fail(error.commandError);
    if (error instanceof HandlerCommandError) return fail(error.commandError);
    opts.onUnexpectedError?.(error);
    return fail(createCommandError("TRANSACTION_FAILED"));
  }

  await publishAfterCommit(opts.eventBus, txnOutcome.events);

  if (
    durableIdempotency === null &&
    txnOutcome.cacheable &&
    txnOutcome.request.idempotencyKey !== undefined &&
    opts.idempotencyStore
  ) {
    await (opts.idempotencyStore as IdempotencyStore).put(
      tenantCtx,
      name,
      txnOutcome.request.idempotencyKey,
      txnOutcome.result,
    );
  }

  return txnOutcome.result;
}

async function runInsideTransaction(
  tx: SqlClient,
  busCtx: BusContext,
  ports: ReturnType<typeof createChainPorts>,
  handler: CommandHandler | undefined,
  opts: ExecuteCommandOptions,
  pendingStore: PendingActionStore,
  durableIdempotency: TransactionalIdempotencyStore | null,
  requestHash: string | undefined,
  replay: CommandResult | null,
): Promise<TxnBody> {
  const transactionBusCtx = bindTransactionClient(busCtx, tx);
  let guardState: unknown;
  if (opts.transactionGuard !== undefined) {
    const decision = await opts.transactionGuard.before(tx, transactionBusCtx);
    if (decision.kind === "return") {
      return { result: decision.result, events: Object.freeze([]), cacheable: false };
    }
    guardState = decision.state;
  }
  const settle = async (body: TxnBody): Promise<TxnBody> => {
    if (opts.transactionGuard !== undefined) {
      await opts.transactionGuard.settle(tx, transactionBusCtx, guardState, body.result);
    }
    return body;
  };

  const chain = await runCommandChain(transactionBusCtx, transactionBusCtx.request.input, ports);
  if (chain.ok === false) {
    return settle({
      result: fail(chainFailureToResult(chain)),
      events: Object.freeze([]),
      cacheable: false,
    });
  }

  if (replay !== null) {
    return settle({ result: replay, events: Object.freeze([]), cacheable: false });
  }

  if (transactionBusCtx.request.dryRun) {
    return settle({
      result: preview(chain.data),
      events: Object.freeze([]),
      cacheable: false,
    });
  }

  if (handler === undefined) {
    throw new CommandBusTxnError(createCommandError("RESOURCE_UNAVAILABLE"));
  }

  if (
    durableIdempotency !== null &&
    transactionBusCtx.request.idempotencyKey !== undefined &&
    requestHash !== undefined
  ) {
    const claim = await durableIdempotency.claim(
      tx,
      transactionBusCtx.tenant,
      transactionBusCtx.request.name,
      transactionBusCtx.request.idempotencyKey,
      requestHash,
    );
    const replay = durableLookupResult(claim);
    if (replay !== null) {
      return settle({ result: replay, events: Object.freeze([]), cacheable: false });
    }
  }

  let approvalAudit: ApprovalAuditEvidence | undefined;
  // Consume pending card after chain pass, before mutation (CAS fail-closed).
  if (transactionBusCtx.confirmAuthorization !== undefined) {
    const nowEpochSeconds = Math.floor((opts.now?.() ?? new Date()).getTime() / 1000);
    const confirmRef = transactionBusCtx.confirmAuthorization.confirmRef;
    const pending = await pendingStore.get(confirmRef, {
      tenant: transactionBusCtx.tenant,
      client: tx,
    });
    let approverStaffId = transactionBusCtx.actor.staffId;

    // Creator resume path: active step-up proof (from other staff PIN) stands in for
    // other-approver identity. Consume proof first (single-use), then pending.
    if (
      pending !== null &&
      pending.requiresOtherApprover &&
      transactionBusCtx.actor.staffId === pending.creatorStaffId
    ) {
      const proofStore = opts.stepUpProofStore ?? processStepUpProofStore;
      const proofTransaction = Object.freeze({ tenant: transactionBusCtx.tenant, client: tx });
      const proof = await proofStore.findActiveByPendingRef(confirmRef, proofTransaction);
      if (proof === null) {
        throw new CommandBusTxnError(createCommandError("POLICY_DENIED"));
      }
      const verified = verifyStepUpProof(
        proof,
        pending,
        nowEpochSeconds,
        opts.sessionBinding ?? null,
      );
      if (verified.ok === false) {
        throw new CommandBusTxnError(createCommandError("POLICY_DENIED"));
      }
      if (!(await proofStore.atomicConsume(proof.proofId, nowEpochSeconds, proofTransaction))) {
        throw new CommandBusTxnError(createCommandError("POLICY_DENIED"));
      }
      approverStaffId = proof.approverStaffId;
    }

    const consume = await pendingStore.atomicConsume(confirmRef, approverStaffId, {
      expectedArgsHash: transactionBusCtx.confirmAuthorization.argsHash,
      nowEpochSeconds,
      transaction: Object.freeze({ tenant: transactionBusCtx.tenant, client: tx }),
    });
    if (consume.ok === false) {
      throw new CommandBusTxnError(createCommandError("POLICY_DENIED"));
    }
    if (consume.action.requiresOtherApprover && consume.action.consumedByStaffId !== null) {
      approvalAudit = Object.freeze({
        initiatedByStaffId: consume.action.creatorStaffId,
        approvedByStaffId: consume.action.consumedByStaffId,
      });
    }
  }

  const outcome = await handler(createHandlerContext(tx, transactionBusCtx, chain.data.parsed));

  await writeAuditForOutcome(tx, transactionBusCtx, outcome.audit, opts, approvalAudit);
  const result = executed(outcome.result);
  if (
    durableIdempotency !== null &&
    transactionBusCtx.request.idempotencyKey !== undefined &&
    requestHash !== undefined
  ) {
    await durableIdempotency.complete(
      tx,
      transactionBusCtx.tenant,
      transactionBusCtx.request.name,
      transactionBusCtx.request.idempotencyKey,
      requestHash,
      result,
    );
  }

  return settle({
    result,
    events: Object.freeze([...(outcome.events ?? [])]),
    cacheable: true,
  });
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
