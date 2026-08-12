import {
  StoreAuthorizedListResultSchema,
  StoreProfileSetInputSchema,
  StoreProfileSetResultSchema,
  type StoreProfileSetInput,
} from "@laundry/contracts";

import type { CommandPort, QueryPort } from "../commands/types.js";
import { unwrapQueryResult } from "../pages/customer-model.js";

export type OwnerAuthorizedStore = Readonly<{
  store_code: string;
  store_name: string;
  timezone: string;
  profile_version: number;
  updated_at: string;
  is_current: boolean;
}>;

export type OwnerStoreDirectory = Readonly<{
  returned_store_count: number;
  truncated: boolean;
  stores: readonly OwnerAuthorizedStore[];
}>;

function freezeStore(store: OwnerAuthorizedStore): OwnerAuthorizedStore {
  return Object.freeze({ ...store });
}

export function parseOwnerStoreDirectory(value: unknown): OwnerStoreDirectory | null {
  const parsed = StoreAuthorizedListResultSchema.safeParse(unwrapQueryResult(value));
  if (!parsed.success) return null;
  return Object.freeze({
    returned_store_count: parsed.data.returned_store_count,
    truncated: parsed.data.truncated,
    stores: Object.freeze(parsed.data.stores.map(freezeStore)),
  });
}

export function parseUpdatedOwnerStore(value: unknown): OwnerAuthorizedStore | null {
  const parsed = StoreProfileSetResultSchema.safeParse(unwrapQueryResult(value));
  return parsed.success ? freezeStore(parsed.data.store) : null;
}

export function buildStoreProfileInput(
  profileVersion: number,
  storeName: string,
  reason: string,
): Readonly<{ ok: true; input: StoreProfileSetInput }> | Readonly<{ ok: false; message: string }> {
  const parsed = StoreProfileSetInputSchema.safeParse({
    expected_profile_version: profileVersion,
    store_name: storeName,
    reason,
  });
  if (!parsed.success) {
    if (storeName.trim().length === 0) {
      return Object.freeze({ ok: false as const, message: "门店名称不能为空" });
    }
    if (reason.trim().length === 0) {
      return Object.freeze({ ok: false as const, message: "请填写名称变更原因" });
    }
    return Object.freeze({ ok: false as const, message: "门店名称或变更原因格式无效" });
  }
  return Object.freeze({ ok: true as const, input: Object.freeze({ ...parsed.data }) });
}

export async function loadOwnerStoreDirectory(queryClient: QueryPort) {
  const response = await queryClient.execute<unknown>("store.authorized.list", {});
  if (!response.ok) {
    return Object.freeze({
      ok: false as const,
      error: response.error.message ?? response.error.code,
    });
  }
  const directory = parseOwnerStoreDirectory(response.data);
  return directory === null
    ? Object.freeze({ ok: false as const, error: "授权门店数据无法解析" })
    : Object.freeze({ ok: true as const, data: directory });
}

export function requestStoreProfileSet(commandClient: CommandPort, input: StoreProfileSetInput) {
  return commandClient.execute<unknown>("store.profile.set", input);
}

export function resumeStoreProfileSet(commandClient: CommandPort, confirmRef: string) {
  return commandClient.execute<unknown>("store.profile.set", {}, { confirmRef });
}
