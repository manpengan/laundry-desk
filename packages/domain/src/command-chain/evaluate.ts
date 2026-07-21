/**
 * B2 — pure command validation chain orchestrator.
 *
 * Fixed order (fail-closed): parseInput → rbac → tenant → policy → invariants.
 * First failure stops; later ports are not invoked.
 * No DB/IO here — only injected ports. Thrown port errors propagate.
 */

import type {
  CommandChainContext,
  CommandChainData,
  CommandChainPorts,
  CommandChainResult,
  CommandChainStep,
} from "./types.js";

const freezeFailure = <TError>(
  step: CommandChainStep,
  error: TError,
): CommandChainFailure<TError> => Object.freeze({ ok: false as const, step, error });

type CommandChainFailure<TError> = Extract<CommandChainResult<never, TError>, { ok: false }>;

const freezeSuccess = <TParsed, TPolicyData, TInvariantData>(
  data: CommandChainData<TParsed, TPolicyData, TInvariantData>,
): Extract<
  CommandChainResult<CommandChainData<TParsed, TPolicyData, TInvariantData>, never>,
  { ok: true }
> =>
  Object.freeze({
    ok: true as const,
    data: Object.freeze({
      parsed: data.parsed,
      policy: data.policy,
      invariants: data.invariants,
    }),
  });

/**
 * Evaluate the five-step validation chain.
 *
 * @param context Immutable host context (meta + raw input). Not mutated.
 * @param ports Injected step callbacks (may be async IO adapters).
 */
export async function evaluateCommandChain<
  TMeta,
  TInput,
  TParsed,
  TError,
  TPolicyData = void,
  TInvariantData = void,
>(
  context: CommandChainContext<TMeta, TInput>,
  ports: CommandChainPorts<TMeta, TInput, TParsed, TError, TPolicyData, TInvariantData>,
): Promise<CommandChainResult<CommandChainData<TParsed, TPolicyData, TInvariantData>, TError>> {
  const parsedResult = await ports.parseInput(context.input, context);
  if (parsedResult.ok === false) {
    return freezeFailure("parseInput", parsedResult.error);
  }

  const parsed = parsedResult.data;

  const rbacResult = await ports.checkRbac(parsed, context);
  if (rbacResult.ok === false) {
    return freezeFailure("rbac", rbacResult.error);
  }

  const tenantResult = await ports.checkTenant(parsed, context);
  if (tenantResult.ok === false) {
    return freezeFailure("tenant", tenantResult.error);
  }

  const policyResult = await ports.checkPolicy(parsed, context);
  if (policyResult.ok === false) {
    return freezeFailure("policy", policyResult.error);
  }

  const policy = policyResult.data;

  const invariantResult = await ports.checkInvariants(parsed, context, policy);
  if (invariantResult.ok === false) {
    return freezeFailure("invariants", invariantResult.error);
  }

  return freezeSuccess({
    parsed,
    policy,
    invariants: invariantResult.data,
  });
}
