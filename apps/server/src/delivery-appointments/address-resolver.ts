import type { DeliveryAppointmentAddress } from "@laundry/contracts";

import type { CustomerProfileStore } from "../customer-profile/types.js";
import type { SqlClient, TenantContext } from "../db/types.js";

const MAX_ACTIVE_ADDRESSES = 100;

export type ResolvedDeliveryAddress = Readonly<{
  customer_id: string;
  address_id: string;
}>;

export type DeliveryAddressBook = Readonly<{
  customer_id: string;
  addresses: readonly Readonly<DeliveryAppointmentAddress>[];
}>;

export type DeliveryAddressResolver = Readonly<{
  resolve: (
    client: SqlClient,
    tenant: TenantContext,
    customerId: string,
    addressId: string,
  ) => Promise<ResolvedDeliveryAddress | null>;
  list: (
    client: SqlClient,
    tenant: TenantContext,
    customerId: string,
  ) => Promise<DeliveryAddressBook | null>;
}>;

type AddressRow = Readonly<{
  customer_id: string;
  address_id: string | null;
  label: string | null;
  address: string | null;
  is_default: boolean | null;
}>;

function freezeAddress(row: AddressRow): DeliveryAppointmentAddress | null {
  if (
    row.address_id === null ||
    row.label === null ||
    row.address === null ||
    row.is_default === null
  ) {
    return null;
  }
  return Object.freeze({
    address_id: row.address_id,
    label: row.label,
    address: row.address,
    is_default: row.is_default,
  });
}

export function createPgDeliveryAddressResolver(): DeliveryAddressResolver {
  return Object.freeze({
    async resolve(client, tenant, customerId, addressId) {
      const result = await client.query<ResolvedDeliveryAddress>(
        `SELECT root.id::text AS customer_id, address_row.id::text AS address_id
           FROM customers requested
           JOIN customers root
             ON root.org_id = requested.org_id
            AND root.id = customer_canonical_root(requested.id)
           JOIN customer_canonical_group(requested.id) canonical ON true
           JOIN customers owner
             ON owner.org_id = requested.org_id
            AND owner.id = canonical.group_customer_id
           JOIN customer_addresses address_row
             ON address_row.org_id = owner.org_id
            AND address_row.customer_id = owner.id
          WHERE requested.org_id = $1::uuid AND requested.id = $2::uuid
            AND root.merged_into_id IS NULL AND root.anonymized_at IS NULL
            AND address_row.id = $3::uuid
            AND address_row.retired_at IS NULL AND address_row.pii_purged_at IS NULL
          FOR SHARE OF requested, root, owner, address_row`,
        [tenant.orgId, customerId, addressId],
      );
      const row = result.rows[0];
      return row === undefined ? null : Object.freeze({ ...row });
    },
    async list(client, tenant, customerId) {
      const result = await client.query<AddressRow>(
        `SELECT root.id::text AS customer_id, address_row.id::text AS address_id,
                address_row.label, address_row.address_body AS address,
                address_row.is_default
           FROM customers requested
           JOIN customers root
             ON root.org_id = requested.org_id
            AND root.id = customer_canonical_root(requested.id)
           JOIN customer_canonical_group(requested.id) canonical ON true
           LEFT JOIN customer_addresses address_row
             ON address_row.org_id = requested.org_id
            AND address_row.customer_id = canonical.group_customer_id
            AND address_row.retired_at IS NULL AND address_row.pii_purged_at IS NULL
          WHERE requested.org_id = $1::uuid AND requested.id = $2::uuid
            AND root.merged_into_id IS NULL AND root.anonymized_at IS NULL
          ORDER BY address_row.is_default DESC NULLS LAST,
                   address_row.updated_at DESC NULLS LAST, address_row.id
          LIMIT 101`,
        [tenant.orgId, customerId],
      );
      const customer = result.rows[0]?.customer_id;
      if (customer === undefined) return null;
      const addresses = result.rows.flatMap((row) => {
        const address = freezeAddress(row);
        return address === null ? [] : [address];
      });
      if (addresses.length > MAX_ACTIVE_ADDRESSES) {
        throw new RangeError("Active delivery address limit exceeded");
      }
      return Object.freeze({ customer_id: customer, addresses: Object.freeze(addresses) });
    },
  });
}

export function createMemoryDeliveryAddressResolver(
  customerProfiles: CustomerProfileStore,
): DeliveryAddressResolver {
  const load = async (customerId: string): Promise<DeliveryAddressBook | null> => {
    const current = await customerProfiles.get(customerId);
    if (current === null) return null;
    const related = (await customerProfiles.listPrivacyProfiles?.(customerId)) ?? [];
    const groupProfiles = Object.freeze([current, ...related]);
    const byId = new Map<string, DeliveryAppointmentAddress>();
    for (const profile of groupProfiles) {
      for (const address of profile.addresses) {
        byId.set(
          address.address_id,
          Object.freeze({
            address_id: address.address_id,
            label: address.label,
            address: address.address,
            is_default: address.is_default,
          }),
        );
      }
    }
    const addresses = [...byId.values()].sort(
      (left, right) =>
        Number(right.is_default) - Number(left.is_default) ||
        left.address_id.localeCompare(right.address_id),
    );
    if (addresses.length > MAX_ACTIVE_ADDRESSES) {
      throw new RangeError("Active delivery address limit exceeded");
    }
    return Object.freeze({ customer_id: current.customer_id, addresses: Object.freeze(addresses) });
  };
  return Object.freeze({
    async resolve(_client, _tenant, customerId, addressId) {
      const result = await load(customerId);
      return result?.addresses.some((address) => address.address_id === addressId) === true
        ? Object.freeze({ customer_id: result.customer_id, address_id: addressId })
        : null;
    },
    async list(_client, _tenant, customerId) {
      return load(customerId);
    },
  });
}
