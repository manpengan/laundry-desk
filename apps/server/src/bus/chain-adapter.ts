/**
 * C1 chain adapter — wires domain evaluateCommandChain with injectable ports.
 * Default RBAC/tenant/policy/invariants allow-all (tests override to fail-closed).
 */

import { createCommandError, parseContractInput, type CommandError } from "@laundry/contracts";
import {
  evaluateCommandChain,
  type CommandChainContext,
  type CommandChainData,
  type CommandChainPorts,
  type CommandChainResult,
  type StepResult,
} from "@laundry/domain";
import { ZodError } from "zod";

import type { BusCommandDefinition, BusContext } from "./types.js";

export type ChainPolicyData = Readonly<{ allowed: true }>;
export type ChainInvariantData = Readonly<{ preview: true }>;

export type BusChainData = CommandChainData<unknown, ChainPolicyData, ChainInvariantData>;
export type BusChainResult = CommandChainResult<BusChainData, CommandError>;

export type BusChainPorts = CommandChainPorts<
  BusContext,
  unknown,
  unknown,
  CommandError,
  ChainPolicyData,
  ChainInvariantData
>;

/** Injectable overrides for steps 2–5 (parse is always definition-bound). */
export type ChainPortHooks = Readonly<{
  checkRbac?: BusChainPorts["checkRbac"];
  checkTenant?: BusChainPorts["checkTenant"];
  checkPolicy?: BusChainPorts["checkPolicy"];
  checkInvariants?: BusChainPorts["checkInvariants"];
}>;

const okVoid = (): StepResult<void, CommandError> => ({ ok: true, data: undefined });

const okPolicy = (): StepResult<ChainPolicyData, CommandError> => ({
  ok: true,
  data: Object.freeze({ allowed: true as const }),
});

const okInvariants = (): StepResult<ChainInvariantData, CommandError> => ({
  ok: true,
  data: Object.freeze({ preview: true as const }),
});

const toValidationError = (error: unknown): CommandError => {
  if (error instanceof ZodError) {
    const first = error.issues[0];
    const path =
      first === undefined || first.path.length === 0 ? "/" : `/${first.path.map(String).join("/")}`;
    return createCommandError("VALIDATION_FAILED", { kind: "field", path });
  }
  return createCommandError("VALIDATION_FAILED");
};

/**
 * Build ports bound to one command definition.
 * parseInput uses A1 parseContractInput (provenance + Zod).
 */
export function createChainPorts(
  definition: BusCommandDefinition,
  hooks: ChainPortHooks = {},
): BusChainPorts {
  return Object.freeze({
    parseInput: async (input: unknown): Promise<StepResult<unknown, CommandError>> => {
      try {
        const parsed = await parseContractInput(definition, input);
        return { ok: true, data: parsed };
      } catch (error) {
        return { ok: false, error: toValidationError(error) };
      }
    },
    checkRbac: hooks.checkRbac ?? (async () => okVoid()),
    checkTenant: hooks.checkTenant ?? (async () => okVoid()),
    checkPolicy: hooks.checkPolicy ?? (async () => okPolicy()),
    checkInvariants: hooks.checkInvariants ?? (async () => okInvariants()),
  });
}

export async function runCommandChain(
  meta: BusContext,
  input: unknown,
  ports: BusChainPorts,
): Promise<BusChainResult> {
  const context: CommandChainContext<BusContext, unknown> = Object.freeze({
    meta,
    input,
  });
  return evaluateCommandChain(context, ports);
}

/** Map chain failure step → stable public error when port returned a bare code gap. */
export function chainFailureToResult(result: Extract<BusChainResult, { ok: false }>): CommandError {
  return result.error;
}
