import { createCommandError } from "@laundry/contracts";

import type { ApprovalStore } from "../approvals/types.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { processPendingActionStore } from "../pending-actions/process-store.js";
import type { PendingActionStore } from "../pending-actions/types.js";
import type { StepUpSessionBinding } from "../policy/step-up.js";
import type { StepUpProofStore } from "../policy/step-up-proof-store.js";
import {
  chainFailureToResult,
  createChainPorts,
  runCommandChain,
  type ChainPortHooks,
} from "./chain-adapter.js";
import { writeAuditForOutcome } from "./audit-outcome.js";
import { buildResolvedCommandRequest, resolveConfirmInput } from "./confirm-input.js";
import {
  abortIdempotencyClaim,
  asTransactionalIdempotencyStore,
  durableLookupResult,
  hashIdempotencyRequest,
  readReplayCandidate,
} from "./durable-idempotency.js";
import {
  CommandBusTxnError,
  executed,
  fail,
  preview,
  publishAfterCommit,
} from "./execution-result.js";
import { bindTransactionClient, createHandlerContext } from "./handler-context.js";
import { consumeConfirmation } from "./consume-confirmation.js";
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
  IdempotencyStore,
  TransactionalIdempotencyStore,
  StepUpApproverAuthority,
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
  pendingStore?: PendingActionStore;
  /** Trusted dedicated approval route only; never parsed from the generic command wire body. */
  approvalStore?: ApprovalStore;
  approvalRef?: string;
  stepUpProofStore?: StepUpProofStore;
  stepUpApproverAuthority?: StepUpApproverAuthority;
  sessionBinding?: StepUpSessionBinding;
  transactionGuard?: CommandTransactionGuard;
  onUnexpectedError?: (error: unknown) => void;
  now?: () => Date;
  newId?: () => string;
}>;

type TxnBody = Readonly<{
  result: CommandResult;
  events: readonly DomainEvent[];
  cacheable: boolean;
  privacySubjectCustomerId?: string;
}>;

type TxnOutcome = TxnBody & Readonly<{ request: CommandRequest }>;

const REPEATABLE_READ_COMMANDS: ReadonlySet<string> = new Set([
  "reconciliation.export",
  "print.ticket.enqueue",
]);

const NON_DURABLE_RESULT_COMMANDS: ReadonlySet<string> = new Set(["customer.privacy.export"]);

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
  const persistedIdempotencyStore = NON_DURABLE_RESULT_COMMANDS.has(name)
    ? undefined
    : opts.idempotencyStore;
  const durableIdempotency = asTransactionalIdempotencyStore(persistedIdempotencyStore);
  const handler = opts.handler ?? registered.handler;
  const ports = createChainPorts(registered.definition, opts.chainHooks);

  let txnOutcome: TxnOutcome;
  let activeClaim: Readonly<{ key: string; requestHash: string }> | null = null;
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
                persistedIdempotencyStore,
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
                  effectiveRisk: resolved.effectiveRisk,
                  policyOutcome: resolved.policyOutcome,
                  requiresOtherApprover: resolved.requiresOtherApprover,
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
          (key, hash) => {
            activeClaim = Object.freeze({ key, requestHash: hash });
          },
        );
        return Object.freeze({ ...outcome, request });
      },
      REPEATABLE_READ_COMMANDS.has(name) ? { isolation: "repeatable_read" } : {},
    );
  } catch (error) {
    await abortIdempotencyClaim(
      durableIdempotency,
      tenantCtx,
      name,
      activeClaim,
      opts.onUnexpectedError,
    );
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
    persistedIdempotencyStore
  ) {
    await (persistedIdempotencyStore as IdempotencyStore).put(
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
  onClaim: (key: string, requestHash: string) => void,
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
      await opts.transactionGuard.settle(
        tx,
        transactionBusCtx,
        guardState,
        body.result,
        body.privacySubjectCustomerId,
      );
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
    onClaim(transactionBusCtx.request.idempotencyKey, requestHash);
  }

  const approvalAudit = await consumeConfirmation(tx, transactionBusCtx, {
    pendingStore,
    now: opts.now?.() ?? new Date(),
    ...(opts.approvalStore === undefined ? {} : { approvalStore: opts.approvalStore }),
    ...(opts.approvalRef === undefined ? {} : { approvalRef: opts.approvalRef }),
    ...(opts.stepUpProofStore === undefined ? {} : { stepUpProofStore: opts.stepUpProofStore }),
    ...(opts.stepUpApproverAuthority === undefined
      ? {}
      : { stepUpApproverAuthority: opts.stepUpApproverAuthority }),
    ...(opts.sessionBinding === undefined ? {} : { sessionBinding: opts.sessionBinding }),
  });

  let outcome: import("./types.js").HandlerOutcome;
  try {
    outcome = await handler(createHandlerContext(tx, transactionBusCtx, chain.data.parsed));
  } catch (error) {
    if (!(error instanceof HandlerCommandError) || error.commandError.code !== "CUSTOMER_ERASED") {
      throw error;
    }
    const terminalResult = fail(error.commandError);
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
        terminalResult,
      );
    }
    return settle({
      result: terminalResult,
      events: Object.freeze([]),
      cacheable: true,
    });
  }

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
      outcome.privacySubjectCustomerId,
    );
  }

  return settle({
    result,
    events: Object.freeze([...(outcome.events ?? [])]),
    cacheable: true,
    ...(outcome.privacySubjectCustomerId === undefined
      ? {}
      : { privacySubjectCustomerId: outcome.privacySubjectCustomerId }),
  });
}
