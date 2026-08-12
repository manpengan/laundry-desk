import type {
  StoreManagementStore,
  StoreProfileSnapshot,
  StoreProfileUpdateResult,
} from "./types.js";

export type MemoryStoreManagementOptions = Readonly<{
  storeCode: string;
  storeName: string;
  timeZone: string;
  profileVersion?: number;
  updatedAt?: Date;
}>;

function freezeSnapshot(snapshot: StoreProfileSnapshot): StoreProfileSnapshot {
  return Object.freeze({ ...snapshot, updatedAt: new Date(snapshot.updatedAt) });
}

export function createMemoryStoreManagementStore(
  options: MemoryStoreManagementOptions,
): StoreManagementStore {
  let current = freezeSnapshot({
    storeCode: options.storeCode,
    storeName: options.storeName,
    timeZone: options.timeZone,
    profileVersion: options.profileVersion ?? 1,
    updatedAt: options.updatedAt ?? new Date("2026-01-01T00:00:00.000Z"),
    isCurrent: true,
  });

  return Object.freeze({
    listAuthorized: async () =>
      Object.freeze({ stores: Object.freeze([freezeSnapshot(current)]), truncated: false }),
    updateCurrent: async (_client, _tenant, input): Promise<StoreProfileUpdateResult> => {
      if (input.expectedProfileVersion !== current.profileVersion) {
        return Object.freeze({ ok: false as const, reason: "stale" as const });
      }
      if (input.storeName === current.storeName) {
        return Object.freeze({ ok: false as const, reason: "unchanged" as const });
      }
      const before = freezeSnapshot(current);
      current = freezeSnapshot({
        ...current,
        storeName: input.storeName,
        profileVersion: current.profileVersion + 1,
        updatedAt: input.at,
      });
      return Object.freeze({ ok: true as const, before, after: freezeSnapshot(current) });
    },
  });
}
