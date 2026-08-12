import { LOCAL_PROFILE } from "../local/profile.js";
import { createMemoryStoreManagementStore } from "./memory-store.js";
import { createPgStoreManagementStore } from "./pg-store.js";
import type { StoreManagementHandlerDeps } from "./types.js";

export function createMemoryStoreManagementDeps(): StoreManagementHandlerDeps {
  return Object.freeze({
    store: createMemoryStoreManagementStore({
      storeCode: LOCAL_PROFILE.storeCode,
      storeName: LOCAL_PROFILE.storeName,
      timeZone: LOCAL_PROFILE.timezone,
    }),
  });
}

export function createPgStoreManagementDeps(): StoreManagementHandlerDeps {
  return Object.freeze({ store: createPgStoreManagementStore() });
}
