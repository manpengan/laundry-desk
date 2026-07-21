/**
 * B2 — command validation chain types.
 *
 * Pure domain ports for the fixed fail-closed order:
 *   Zod parse → RBAC → tenant → Policy → invariants
 *
 * IO (DB, keychain, network) lives only inside injected port callbacks.
 * The orchestrator never performs side effects itself.
 */

/** Fixed step names in execution order. Do not reorder. */
export const COMMAND_CHAIN_STEPS = [
  "parseInput",
  "rbac",
  "tenant",
  "policy",
  "invariants",
] as const;

export type CommandChainStep = (typeof COMMAND_CHAIN_STEPS)[number];

export type StepSuccess<TData> = Readonly<{
  ok: true;
  data: TData;
}>;

export type StepFailure<TError> = Readonly<{
  ok: false;
  error: TError;
}>;

/** Per-port result. Failures stop the chain; no silent recovery. */
export type StepResult<TData, TError> = StepSuccess<TData> | StepFailure<TError>;

export type CommandChainSuccessResult<TData> = Readonly<{
  ok: true;
  data: TData;
}>;

export type CommandChainFailureResult<TError> = Readonly<{
  ok: false;
  step: CommandChainStep;
  error: TError;
}>;

/**
 * Chain outcome.
 * - success: all five steps passed; `data` is frozen progressive payload
 * - failure: first failing step name + its error (later steps not run)
 */
export type CommandChainResult<TData, TError> =
  | CommandChainSuccessResult<TData>
  | CommandChainFailureResult<TError>;

/**
 * Immutable evaluation context.
 * Host supplies `meta` (actor/tenant/command metadata) and raw `input`.
 * `evaluateCommandChain` never mutates either field.
 */
export type CommandChainContext<TMeta = unknown, TInput = unknown> = Readonly<{
  meta: TMeta;
  input: TInput;
}>;

/** Progressive success payload after all validation steps. */
export type CommandChainData<TParsed, TPolicyData = void, TInvariantData = void> = Readonly<{
  parsed: TParsed;
  policy: TPolicyData;
  invariants: TInvariantData;
}>;

export type MaybePromise<T> = T | Promise<T>;

/**
 * Injected IO ports. Server (C1) wires real adapters; tests inject pure stubs.
 * Ports return Result — thrown errors propagate (no silent catch in evaluate).
 */
export type CommandChainPorts<
  TMeta,
  TInput,
  TParsed,
  TError,
  TPolicyData = void,
  TInvariantData = void,
> = Readonly<{
  /** 1. Zod (or equivalent) parse of raw input. */
  parseInput: (
    input: TInput,
    context: CommandChainContext<TMeta, TInput>,
  ) => MaybePromise<StepResult<TParsed, TError>>;

  /** 2. RBAC against authenticated actor. */
  checkRbac: (
    parsed: TParsed,
    context: CommandChainContext<TMeta, TInput>,
  ) => MaybePromise<StepResult<void, TError>>;

  /** 3. Tenant / data-scope check (pairs with RLS). */
  checkTenant: (
    parsed: TParsed,
    context: CommandChainContext<TMeta, TInput>,
  ) => MaybePromise<StepResult<void, TError>>;

  /** 4. Policy / risk engine (confirm / step-up / deny / allow). */
  checkPolicy: (
    parsed: TParsed,
    context: CommandChainContext<TMeta, TInput>,
  ) => MaybePromise<StepResult<TPolicyData, TError>>;

  /** 5. Business invariants (dry_run preview may return here). */
  checkInvariants: (
    parsed: TParsed,
    context: CommandChainContext<TMeta, TInput>,
    policy: TPolicyData,
  ) => MaybePromise<StepResult<TInvariantData, TError>>;
}>;
