import type { CommandDefinition, QueryDefinition } from "../registry/definitions.js";
import { IDENTITY_COMMANDS, IDENTITY_COMMAND_NAMES } from "./identity.js";
import { CATALOG_SKELETON_DEFINITIONS, CATALOG_SKELETON_QUERY_NAMES } from "./catalog-items.js";
import {
  M2_CUSTOMER_COMMAND_DEFINITIONS,
  M2_CUSTOMER_COMMAND_NAMES,
  M2_CUSTOMER_QUERY_DEFINITIONS,
  M2_CUSTOMER_QUERY_NAMES,
} from "./customer.js";
import { ORDER_COMMANDS, ORDER_COMMAND_NAMES, ORDER_QUERIES, ORDER_QUERY_NAMES } from "./order.js";
import { PAYMENT_COMMANDS, PAYMENT_COMMAND_NAMES } from "./payment.js";
import { PLATFORM_COMMANDS, PLATFORM_DEFINITIONS, PLATFORM_QUERIES } from "./platform.js";
import {
  M2_PRINT_COMMAND_DEFINITIONS,
  M2_PRINT_COMMAND_NAMES,
  M2_PRINT_QUERY_DEFINITIONS,
  M2_PRINT_QUERY_NAMES,
} from "./print.js";
import {
  M2_SHIFT_COMMAND_DEFINITIONS,
  M2_SHIFT_COMMAND_NAMES,
  M2_SHIFT_QUERY_DEFINITIONS,
  M2_SHIFT_QUERY_NAMES,
} from "./shift.js";
import {
  M3_PHOTO_COMMAND_DEFINITIONS,
  M3_PHOTO_COMMAND_NAMES,
  M3_PHOTO_QUERY_DEFINITIONS,
  M3_PHOTO_QUERY_NAMES,
} from "./photo.js";
import { M2_STATS_QUERY_DEFINITIONS, M2_STATS_QUERY_NAMES } from "./stats.js";
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
 * M2/M3 skeleton commands (order + print + customer + shift + photo register).
 * Not yet in OpenAPI freeze snapshot; server loads via createM1CommandRegistry([...M1, ...M2/M3]).
 */
export const M2_SKELETON_DEFINITIONS: readonly CommandDefinition<z.ZodObject>[] = Object.freeze([
  ...ORDER_COMMANDS,
  ...PAYMENT_COMMANDS,
  ...M2_PRINT_COMMAND_DEFINITIONS,
  ...M2_CUSTOMER_COMMAND_DEFINITIONS,
  ...M2_SHIFT_COMMAND_DEFINITIONS,
  ...M3_PHOTO_COMMAND_DEFINITIONS,
]);

export const M2_SKELETON_COMMAND_NAMES = Object.freeze([
  ...M2_CUSTOMER_COMMAND_NAMES,
  ...ORDER_COMMAND_NAMES,
  ...PAYMENT_COMMAND_NAMES,
  ...M2_PRINT_COMMAND_NAMES,
  ...M2_SHIFT_COMMAND_NAMES,
  ...M3_PHOTO_COMMAND_NAMES,
] as const) as readonly [
  "customer.upsert",
  "order.receive",
  "order.hold",
  "order.cancel",
  "order.pickup",
  "payment.collect",
  "payment.repay",
  "payment.refund",
  "print.ticket.enqueue",
  "print.ticket.process",
  "print.ticket.retry",
  "print.ticket.reprint",
  "shift.close",
  "photo.register",
];

/**
 * M2 order read queries (order.get + order.list for counter UX).
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

/** Frozen v0.2 M2 contract surface consumed by server, Web and Edge. */
export const M2_CONTRACT_COMMAND_NAMES = M2_SKELETON_COMMAND_NAMES;

export const M2_CONTRACT_QUERY_NAMES = Object.freeze([
  ...CATALOG_SKELETON_QUERY_NAMES,
  ...M2_CUSTOMER_QUERY_NAMES,
  ...ORDER_QUERY_NAMES,
  ...M2_PRINT_QUERY_NAMES,
  ...M2_STATS_QUERY_NAMES,
  ...M2_SHIFT_QUERY_NAMES,
  ...M3_PHOTO_QUERY_NAMES,
] as const);

export const M2_CONTRACT_DEFINITIONS: readonly (
  CommandDefinition<z.ZodObject> | QueryDefinition<z.ZodObject>
)[] = Object.freeze([
  ...M2_SKELETON_DEFINITIONS,
  ...CATALOG_SKELETON_DEFINITIONS,
  ...M2_CUSTOMER_QUERY_DEFINITIONS,
  ...ORDER_QUERIES,
  ...M2_PRINT_QUERY_DEFINITIONS,
  ...M2_STATS_QUERY_DEFINITIONS,
  ...M2_SHIFT_QUERY_DEFINITIONS,
  ...M3_PHOTO_QUERY_DEFINITIONS,
]);

/** M2 AI presets are read-only: no command is exposed to the tool projection. */
export const M2_READ_ONLY_AI_DEFINITIONS: readonly QueryDefinition<z.ZodObject>[] = Object.freeze([
  ...CATALOG_SKELETON_DEFINITIONS,
  ...M2_CUSTOMER_QUERY_DEFINITIONS,
  ...ORDER_QUERIES,
  ...M2_PRINT_QUERY_DEFINITIONS,
  ...M2_STATS_QUERY_DEFINITIONS,
  ...M2_SHIFT_QUERY_DEFINITIONS,
  ...M3_PHOTO_QUERY_DEFINITIONS,
]);

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

/**
 * M2 daily revenue queries (stats.day.summary). Order-backed skeleton;
 * not in OpenAPI freeze. Re-exported for registry loaders.
 */
export { M2_STATS_QUERY_DEFINITIONS, M2_STATS_QUERY_NAMES };

/**
 * M2 customer archive (customer.search + customer.upsert). Memory-first;
 * not in OpenAPI freeze. Re-exported for registry loaders.
 */
export {
  M2_CUSTOMER_COMMAND_DEFINITIONS,
  M2_CUSTOMER_COMMAND_NAMES,
  M2_CUSTOMER_QUERY_DEFINITIONS,
  M2_CUSTOMER_QUERY_NAMES,
};

/**
 * M2 shift closing (shift.close + shift.get). Memory-first 日结签字;
 * not in OpenAPI freeze. Re-exported for registry loaders.
 */
export {
  M2_SHIFT_COMMAND_DEFINITIONS,
  M2_SHIFT_COMMAND_NAMES,
  M2_SHIFT_QUERY_DEFINITIONS,
  M2_SHIFT_QUERY_NAMES,
};

/**
 * M3 garment photo metadata (photo.register + photo.list_by_order). Memory-first;
 * not in OpenAPI freeze. Re-exported for registry loaders.
 */
export {
  M3_PHOTO_COMMAND_DEFINITIONS,
  M3_PHOTO_COMMAND_NAMES,
  M3_PHOTO_QUERY_DEFINITIONS,
  M3_PHOTO_QUERY_NAMES,
};
