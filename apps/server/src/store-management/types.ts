import type { SqlClient, TenantContext } from "../db/types.js";

export type StoreProfileSnapshot = Readonly<{
  storeCode: string;
  storeName: string;
  timeZone: string;
  profileVersion: number;
  updatedAt: Date;
  isCurrent: boolean;
}>;

export type AuthorizedStoreDirectory = Readonly<{
  stores: readonly StoreProfileSnapshot[];
  truncated: boolean;
}>;

export type StoreProfileUpdateResult =
  | Readonly<{
      ok: true;
      before: StoreProfileSnapshot;
      after: StoreProfileSnapshot;
    }>
  | Readonly<{ ok: false; reason: "missing" | "stale" | "unchanged" }>;

export type StoreManagementStore = Readonly<{
  listAuthorized: (client: SqlClient, tenant: TenantContext) => Promise<AuthorizedStoreDirectory>;
  updateCurrent: (
    client: SqlClient,
    tenant: TenantContext,
    input: Readonly<{
      expectedProfileVersion: number;
      storeName: string;
      at: Date;
    }>,
  ) => Promise<StoreProfileUpdateResult>;
}>;

export type StoreManagementHandlerDeps = Readonly<{
  store: StoreManagementStore;
  now?: () => Date;
}>;
