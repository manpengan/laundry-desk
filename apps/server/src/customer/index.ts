export { createMemoryCustomerStore, DEMO_CUSTOMERS, MemoryCustomerStore } from "./memory-store.js";
export { createPgCustomerStore, type CreatePgCustomerStoreOptions } from "./pg-customer-store.js";
export {
  registerCustomerCommandHandlers,
  registerCustomerQueryHandlers,
  type CustomerHandlerDeps,
} from "./handlers.js";
export type {
  CustomerRecord,
  CustomerSearchRow,
  CustomerStore,
  CustomerUpsertInput,
  CustomerUpsertOutcome,
} from "./types.js";
