import type { ReconciliationDayResult } from "@laundry/contracts";

import type { SqlClient, TenantContext } from "../db/types.js";

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type ReconciliationSnapshot = DeepReadonly<Omit<ReconciliationDayResult, "generated_at">>;

export type ReconciliationReadInput = Readonly<{
  client: SqlClient;
  tenant: TenantContext;
  businessDate: string;
}>;

export type ReconciliationReadPort = Readonly<{
  readDay: (input: ReconciliationReadInput) => Promise<ReconciliationSnapshot>;
}>;

export type EdgeConflictReadPort = Readonly<{
  hasDiscardableConflict: (
    client: SqlClient,
    tenant: TenantContext,
    queueId: string,
  ) => Promise<boolean>;
}>;

export type ReconciliationHandlerDeps = Readonly<{
  source: ReconciliationReadPort;
  edgeConflicts: EdgeConflictReadPort;
  timeZone: string;
  rolloverHour?: number;
  now?: () => Date;
}>;
