import type { MemberStore } from "../member/types.js";
import type { OrderStore } from "../order/types.js";
import { createMemoryMemberBenefitsStore } from "./memory-store.js";
import type { MemberBenefitsRuntimeDeps } from "./types.js";

export function createMemoryMemberBenefitsDeps(options: {
  orgId: string;
  memberStore: MemberStore;
  orderStore: OrderStore;
}): MemberBenefitsRuntimeDeps {
  return Object.freeze({
    persistence: "memory" as const,
    store: createMemoryMemberBenefitsStore(options),
  });
}

/** PostgreSQL handlers replace this placeholder with a transaction-scoped store. */
export function createPgMemberBenefitsDeps(options: {
  orgId: string;
  memberStore: MemberStore;
  orderStore: OrderStore;
}): MemberBenefitsRuntimeDeps {
  return Object.freeze({
    persistence: "sql" as const,
    store: createMemoryMemberBenefitsStore(options),
  });
}
