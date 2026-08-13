export {
  M3_FULFILLMENT_COMMAND_DEFINITIONS,
  M3_FULFILLMENT_QUERY_DEFINITIONS,
} from "./fulfillment.js";
export { ACCOUNTING_COMMANDS, ACCOUNTING_QUERIES } from "./accounting.js";
export { RECONCILIATION_COMMANDS, RECONCILIATION_QUERIES } from "./reconciliation.js";
export { EDGE_CONFLICT_COMMANDS } from "./edge-conflict.js";

/**
 * M2 print job status queries (print.jobs.list). Memory-first skeleton;
 * not in OpenAPI freeze. Re-exported for registry loaders.
 */
export {
  M2_PRINT_QUERY_DEFINITIONS,
  M2_PRINT_QUERY_NAMES,
  M2_PRINT_COMMAND_DEFINITIONS,
  M2_PRINT_COMMAND_NAMES,
} from "./print.js";

/**
 * M2 daily revenue queries (stats.day.summary). Order-backed skeleton;
 * not in OpenAPI freeze. Re-exported for registry loaders.
 */
export { M2_STATS_QUERY_DEFINITIONS, M2_STATS_QUERY_NAMES } from "./stats.js";

/**
 * M2 customer archive (customer.search + customer.upsert). Memory-first;
 * not in OpenAPI freeze. Re-exported for registry loaders.
 */
export {
  M2_CUSTOMER_COMMAND_DEFINITIONS,
  M2_CUSTOMER_COMMAND_NAMES,
  M2_CUSTOMER_QUERY_DEFINITIONS,
  M2_CUSTOMER_QUERY_NAMES,
} from "./customer.js";

/**
 * M2 shift closing (shift.close + shift.get). Memory-first 日结签字;
 * not in OpenAPI freeze. Re-exported for registry loaders.
 */
export {
  M2_SHIFT_COMMAND_DEFINITIONS,
  M2_SHIFT_COMMAND_NAMES,
  M2_SHIFT_QUERY_DEFINITIONS,
  M2_SHIFT_QUERY_NAMES,
} from "./shift.js";

/**
 * M3 garment photo metadata (photo.register + photo.list_by_order). Memory-first;
 * not in OpenAPI freeze. Re-exported for registry loaders.
 */
export {
  M3_PHOTO_COMMAND_DEFINITIONS,
  M3_PHOTO_COMMAND_NAMES,
  M3_PHOTO_QUERY_DEFINITIONS,
  M3_PHOTO_QUERY_NAMES,
} from "./photo.js";
