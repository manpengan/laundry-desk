import type { CommandDefinition, QueryDefinition } from "../registry/definitions.js";
import { IDENTITY_COMMANDS, IDENTITY_COMMAND_NAMES } from "./identity.js";
import { CATALOG_SKELETON_DEFINITIONS, CATALOG_SKELETON_QUERY_NAMES } from "./catalog-items.js";
import { ORDER_COMMANDS, ORDER_COMMAND_NAMES, ORDER_QUERIES, ORDER_QUERY_NAMES } from "./order.js";
import { PLATFORM_COMMANDS, PLATFORM_DEFINITIONS, PLATFORM_QUERIES } from "./platform.js";
import {
  M2_PRINT_COMMAND_DEFINITIONS,
  M2_PRINT_COMMAND_NAMES,
  M2_PRINT_QUERY_DEFINITIONS,
  M2_PRINT_QUERY_NAMES,
} from "./print.js";
import type { z } from "zod";

/** M1 first-wave registered definitions (A6). OpenAPI snapshot remains M1-only. */
export const M1_FIRST_WAVE_DEFINITIONS: readonly (
  CommandDefinition<z.ZodObject> | QueryDefinition<z.ZodObject>
)[] = Object.freeze([...IDENTITY_COMMANDS, ...PLATFORM_DEFINITIONS]);

export const M1_FIRST_WAVE_COMMAND_NAMES = Object.freeze([
  ...IDENTITY_COMMAND_NAMES,
  ...PLATFORM_COMMANDS.map((command) => command.name),
] as const);

export const M1_FIRST_WAVE_QUERY_NAMES = Object.freeze(PLATFORM_QUERIES.map((query) => query.name));

/**
 * M2 skeleton commands (order receive/pickup + print enqueue). Not yet in OpenAPI
 * freeze snapshot; server loads via createM1CommandRegistry([...M1, ...M2]).
 */
export const M2_SKELETON_DEFINITIONS: readonly CommandDefinition<z.ZodObject>[] = Object.freeze([
  ...ORDER_COMMANDS,
  ...M2_PRINT_COMMAND_DEFINITIONS,
]);

export const M2_SKELETON_COMMAND_NAMES = Object.freeze([
  ...ORDER_COMMAND_NAMES,
  ...M2_PRINT_COMMAND_NAMES,
] as const);

/**
 * M2 order read queries (order.get for partial pickup UX).
 * Not in OpenAPI freeze; load via query registry separately from commands.
 */
export const M2_ORDER_QUERY_DEFINITIONS: readonly QueryDefinition<z.ZodObject>[] = Object.freeze([
  ...ORDER_QUERIES,
]);

export const M2_ORDER_QUERY_NAMES = ORDER_QUERY_NAMES;

/**
 * M2 catalog item queries (price list). Separate from order commands so
 * command registry and query registry can load independently.
 */
export const M2_CATALOG_DEFINITIONS: readonly QueryDefinition<z.ZodObject>[] = Object.freeze([
  ...CATALOG_SKELETON_DEFINITIONS,
]);

export const M2_CATALOG_QUERY_NAMES = CATALOG_SKELETON_QUERY_NAMES;

/**
 * M2 print job status queries (print.jobs.list). Memory-first skeleton;
 * not in OpenAPI freeze. Re-exported for registry loaders.
 */
export {
  M2_PRINT_QUERY_DEFINITIONS,
  M2_PRINT_QUERY_NAMES,
  M2_PRINT_COMMAND_DEFINITIONS,
  M2_PRINT_COMMAND_NAMES,
};
