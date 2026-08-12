import { randomUUID } from "node:crypto";

import type { CustomerStore } from "../customer/types.js";
import { normalizeCustomerIdentifier } from "../customer/normalization.js";
import {
  CustomerIdentifierConflictError,
  type CustomerProfileSetStoreInput,
  type CustomerProfileStore,
  type CustomerProfileView,
} from "./types.js";

type ProfileSnapshot = CustomerProfileView & Readonly<{ owner_customer_id: string }>;

const EMPTY_WAIVERS = Object.freeze({
  skip_ticket_print: false,
  skip_label_print: false,
  skip_rack_assignment: false,
});

function emptyProfile(customerId: string): CustomerProfileView {
  return Object.freeze({
    customer_id: customerId,
    version: 0,
    gender: "unspecified" as const,
    preferred_contact: "none" as const,
    service_note: null,
    waivers: EMPTY_WAIVERS,
    discount_bps: null,
    addresses: Object.freeze([]),
    identifiers: Object.freeze([]),
    updated_at: null,
  });
}

function publicProfile(snapshot: ProfileSnapshot, rootId: string): CustomerProfileView {
  return Object.freeze({
    customer_id: rootId,
    version: snapshot.version,
    gender: snapshot.gender,
    preferred_contact: snapshot.preferred_contact,
    service_note: snapshot.service_note,
    waivers: Object.freeze({ ...snapshot.waivers }),
    discount_bps: snapshot.discount_bps,
    addresses: Object.freeze(snapshot.addresses.map((address) => Object.freeze({ ...address }))),
    identifiers: Object.freeze(
      snapshot.identifiers.map((identifier) => Object.freeze({ ...identifier })),
    ),
    updated_at: snapshot.updated_at,
  });
}

export function createMemoryCustomerProfileStore(
  customers: CustomerStore,
  newId: () => string = randomUUID,
): CustomerProfileStore {
  const profiles = new Map<string, ProfileSnapshot>();

  async function authority(customerId: string): Promise<Readonly<{
    rootId: string;
    groupIds: readonly string[];
    snapshot: ProfileSnapshot | null;
  }> | null> {
    const customer = await customers.getById(customerId);
    if (customer === null) return null;
    const rootId = customer.customer_id;
    const groupIds = (await customers.listCanonicalGroup?.(rootId)) ?? Object.freeze([rootId]);
    const rootProfile = profiles.get(rootId);
    const candidates = groupIds
      .map((id) => profiles.get(id))
      .filter((entry): entry is ProfileSnapshot => entry !== undefined)
      .sort((left, right) => (right.updated_at ?? 0) - (left.updated_at ?? 0));
    return Object.freeze({
      rootId,
      groupIds,
      snapshot: rootProfile ?? candidates[0] ?? null,
    });
  }

  function assertIdentifiersAvailable(
    input: CustomerProfileSetStoreInput,
    groupIds: readonly string[],
  ): void {
    const requested = new Set<string>();
    for (const identifier of input.identifiers) {
      const key = `${identifier.kind}:${normalizeCustomerIdentifier(identifier.value)}`;
      if (requested.has(key)) throw new CustomerIdentifierConflictError();
      requested.add(key);
    }
    for (const [ownerId, profile] of profiles.entries()) {
      if (groupIds.includes(ownerId)) continue;
      for (const identifier of profile.identifiers) {
        const key = `${identifier.kind}:${normalizeCustomerIdentifier(identifier.value)}`;
        if (requested.has(key)) throw new CustomerIdentifierConflictError();
      }
    }
  }

  return Object.freeze({
    get: async (customerId) => {
      const current = await authority(customerId);
      if (current === null) return null;
      return current.snapshot === null
        ? emptyProfile(current.rootId)
        : publicProfile(current.snapshot, current.rootId);
    },

    getForOrder: async (customerId) => {
      const current = await authority(customerId);
      if (current === null) return null;
      return current.snapshot === null
        ? emptyProfile(current.rootId)
        : publicProfile(current.snapshot, current.rootId);
    },

    listPrivacyProfiles: async (customerId) => {
      const current = await authority(customerId);
      if (current === null) return Object.freeze([]);
      const snapshots = current.groupIds
        .map((id) => profiles.get(id))
        .filter((entry): entry is ProfileSnapshot => entry !== undefined)
        .sort((left, right) => {
          const rootOrder =
            Number(right.owner_customer_id === current.rootId) -
            Number(left.owner_customer_id === current.rootId);
          if (rootOrder !== 0) return rootOrder;
          const updatedOrder = (right.updated_at ?? 0) - (left.updated_at ?? 0);
          return updatedOrder !== 0
            ? updatedOrder
            : left.owner_customer_id.localeCompare(right.owner_customer_id);
        });
      return Object.freeze(
        snapshots.map((snapshot) => publicProfile(snapshot, snapshot.owner_customer_id)),
      );
    },

    findCustomerIdsByIdentifier: async (value) => {
      const normalized = normalizeCustomerIdentifier(value);
      const matches = new Set<string>();
      for (const profile of profiles.values()) {
        if (
          profile.identifiers.some(
            (identifier) => normalizeCustomerIdentifier(identifier.value) === normalized,
          )
        ) {
          const customer = await customers.getById(profile.customer_id);
          if (customer !== null) matches.add(customer.customer_id);
        }
      }
      return Object.freeze([...matches].sort());
    },

    setProfile: async (input) => {
      const current = await authority(input.customer_id);
      if (current === null) return null;
      const currentVersion = current.snapshot?.version ?? 0;
      if (currentVersion !== input.expected_version) return null;
      assertIdentifiersAvailable(input, current.groupIds);

      for (const groupId of current.groupIds) profiles.delete(groupId);
      const snapshot: ProfileSnapshot = Object.freeze({
        owner_customer_id: current.rootId,
        customer_id: current.rootId,
        version: currentVersion + 1,
        gender: input.gender,
        preferred_contact: input.preferred_contact,
        service_note: input.service_note,
        waivers: Object.freeze({ ...input.waivers }),
        discount_bps: current.snapshot?.discount_bps ?? null,
        addresses: Object.freeze(
          input.addresses.map((address) => Object.freeze({ ...address, address_id: newId() })),
        ),
        identifiers: Object.freeze(
          input.identifiers.map((identifier) =>
            Object.freeze({ ...identifier, identifier_id: newId() }),
          ),
        ),
        updated_at: input.at,
      });
      profiles.set(current.rootId, snapshot);
      return publicProfile(snapshot, current.rootId);
    },

    setDiscount: async (input) => {
      const current = await authority(input.customer_id);
      if (current === null) return null;
      const existing = current.snapshot;
      const currentVersion = existing?.version ?? 0;
      if (currentVersion !== input.expected_version) return null;
      const ownerId = existing?.owner_customer_id ?? current.rootId;
      const base = existing ?? { ...emptyProfile(current.rootId), owner_customer_id: ownerId };
      const snapshot: ProfileSnapshot = Object.freeze({
        ...base,
        owner_customer_id: ownerId,
        customer_id: current.rootId,
        version: currentVersion + 1,
        discount_bps: input.discount_bps,
        updated_at: input.at,
      });
      profiles.set(ownerId, snapshot);
      return publicProfile(snapshot, current.rootId);
    },

    purgeCustomerPii: async (customerId, canonicalGroupIds) => {
      const subjectIds = new Set(canonicalGroupIds ?? [customerId]);
      const matchingOwners = [...profiles.entries()]
        .filter(
          ([ownerId, profile]) => subjectIds.has(ownerId) || subjectIds.has(profile.customer_id),
        )
        .map(([ownerId]) => ownerId);
      for (const ownerId of matchingOwners) profiles.delete(ownerId);
    },
  });
}
