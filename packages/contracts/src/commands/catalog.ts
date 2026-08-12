import type { CommandDefinition, QueryDefinition } from "../registry/definitions.js";
import type { z } from "zod";
import {
  M2_CONTRACT_COMMAND_NAMES as BASE_COMMAND_NAMES,
  M2_CONTRACT_DEFINITIONS as BASE_DEFINITIONS,
  M2_CONTRACT_QUERY_NAMES as BASE_QUERY_NAMES,
  M2_SKELETON_COMMAND_NAMES as BASE_SKELETON_COMMAND_NAMES,
  M2_SKELETON_DEFINITIONS as BASE_SKELETON_DEFINITIONS,
} from "./catalog-base.js";
import {
  DELIVERY_POLICY_COMMAND_NAMES,
  DELIVERY_POLICY_COMMANDS,
  DELIVERY_POLICY_QUERIES,
  DELIVERY_POLICY_QUERY_NAMES,
} from "./delivery-policy.js";

export * from "./catalog-base.js";

/** ADR-46 extends the frozen surface while keeping the historical catalog module bounded. */
export const M2_SKELETON_DEFINITIONS: readonly CommandDefinition<z.ZodObject>[] = Object.freeze([
  ...BASE_SKELETON_DEFINITIONS,
  ...DELIVERY_POLICY_COMMANDS,
]);

export const M2_SKELETON_COMMAND_NAMES = Object.freeze([
  ...BASE_SKELETON_COMMAND_NAMES,
  ...DELIVERY_POLICY_COMMAND_NAMES,
] as const);

export const M2_CONTRACT_COMMAND_NAMES = Object.freeze([
  ...BASE_COMMAND_NAMES,
  ...DELIVERY_POLICY_COMMAND_NAMES,
] as const);

export const M2_CONTRACT_QUERY_NAMES = Object.freeze([
  ...BASE_QUERY_NAMES,
  ...DELIVERY_POLICY_QUERY_NAMES,
] as const);

export const M2_CONTRACT_DEFINITIONS: readonly (
  CommandDefinition<z.ZodObject> | QueryDefinition<z.ZodObject>
)[] = Object.freeze([...BASE_DEFINITIONS, ...DELIVERY_POLICY_COMMANDS, ...DELIVERY_POLICY_QUERIES]);
