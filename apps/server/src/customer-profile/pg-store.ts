import { randomUUID } from "node:crypto";

import type { CustomerProfileResult } from "@laundry/contracts";

import type { PgPool } from "../db/pg-pool.js";
import { withOrgGucOrCurrent, withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
import { normalizeCustomerIdentifier } from "../customer/normalization.js";
import {
  CustomerIdentifierConflictError,
  type CustomerDiscountSetStoreInput,
  type CustomerProfileSetStoreInput,
  type CustomerProfileStore,
  type CustomerProfileView,
} from "./types.js";

type ProfileRow = Readonly<{
  customer_id: string;
  version: number;
  gender: CustomerProfileResult["gender"];
  preferred_contact: CustomerProfileResult["preferred_contact"];
  service_note: string | null;
  skip_ticket_print: boolean;
  skip_label_print: boolean;
  skip_rack_assignment: boolean;
  discount_bps: number | null;
  updated_at: Date | string;
}>;

type AddressRow = Readonly<{
  address_id: string;
  label: string;
  recipient: string | null;
  contact_phone: string | null;
  address: string;
  is_default: boolean;
}>;

type IdentifierRow = Readonly<{
  identifier_id: string;
  kind: CustomerProfileResult["identifiers"][number]["kind"];
  value: string;
}>;

function epoch(value: Date | string): number {
  return Math.floor(new Date(value).getTime() / 1000);
}

async function resolveRoot(
  client: SqlClient,
  orgId: string,
  customerId: string,
  lock: boolean,
): Promise<string | null> {
  const result = await client.query<Readonly<{ root_id: string }>>(
    `SELECT root.id::text AS root_id
       FROM customers requested
       JOIN customers root
         ON root.org_id = requested.org_id
        AND root.id = customer_canonical_root(requested.id)
      WHERE requested.org_id = $1::uuid AND requested.id = $2::uuid
        AND root.merged_into_id IS NULL AND root.anonymized_at IS NULL
      ${lock ? "FOR UPDATE OF root" : ""}`,
    [orgId, customerId],
  );
  return result.rows[0]?.root_id ?? null;
}

async function loadProfileRow(
  client: SqlClient,
  orgId: string,
  rootId: string,
): Promise<ProfileRow | null> {
  const result = await client.query<ProfileRow>(
    `SELECT profile.customer_id::text, profile.version, profile.gender,
            profile.preferred_contact, profile.service_note,
            profile.skip_ticket_print, profile.skip_label_print,
            profile.skip_rack_assignment, profile.discount_bps, profile.updated_at
       FROM customer_profiles profile
       JOIN customer_canonical_group($2::uuid) canonical
         ON canonical.group_customer_id = profile.customer_id
      WHERE profile.org_id = $1::uuid
      ORDER BY (profile.customer_id = $2::uuid) DESC, profile.updated_at DESC
      LIMIT 1`,
    [orgId, rootId],
  );
  return result.rows[0] ?? null;
}

async function loadProfile(
  client: SqlClient,
  orgId: string,
  rootId: string,
): Promise<CustomerProfileView> {
  const profile = await loadProfileRow(client, orgId, rootId);
  if (profile === null) {
    return Object.freeze({
      customer_id: rootId,
      version: 0,
      gender: "unspecified",
      preferred_contact: "none",
      service_note: null,
      waivers: Object.freeze({
        skip_ticket_print: false,
        skip_label_print: false,
        skip_rack_assignment: false,
      }),
      discount_bps: null,
      addresses: Object.freeze([]),
      identifiers: Object.freeze([]),
      updated_at: null,
    });
  }
  const [addresses, identifiers] = await Promise.all([
    client.query<AddressRow>(
      `SELECT id::text AS address_id, label, recipient, contact_phone,
              address_body AS address, is_default
         FROM customer_addresses
        WHERE org_id = $1::uuid AND customer_id = $2::uuid
          AND profile_version = $3 AND retired_at IS NULL
        ORDER BY is_default DESC, created_at, id`,
      [orgId, profile.customer_id, profile.version],
    ),
    client.query<IdentifierRow>(
      `SELECT id::text AS identifier_id, kind, raw_value AS value
         FROM customer_identifiers
        WHERE org_id = $1::uuid AND customer_id = $2::uuid
          AND profile_version = $3 AND retired_at IS NULL
        ORDER BY kind, created_at, id`,
      [orgId, profile.customer_id, profile.version],
    ),
  ]);
  return Object.freeze({
    customer_id: rootId,
    version: profile.version,
    gender: profile.gender,
    preferred_contact: profile.preferred_contact,
    service_note: profile.service_note,
    waivers: Object.freeze({
      skip_ticket_print: profile.skip_ticket_print,
      skip_label_print: profile.skip_label_print,
      skip_rack_assignment: profile.skip_rack_assignment,
    }),
    discount_bps: profile.discount_bps,
    addresses: Object.freeze(addresses.rows.map((row) => Object.freeze({ ...row }))),
    identifiers: Object.freeze(identifiers.rows.map((row) => Object.freeze({ ...row }))),
    updated_at: epoch(profile.updated_at),
  });
}

async function lockProfileGroup(client: SqlClient, orgId: string, rootId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `customer-profile:${orgId}:${rootId}`,
  ]);
  await client.query(
    `SELECT profile.customer_id
       FROM customer_profiles profile
       JOIN customer_canonical_group($2::uuid) canonical
         ON canonical.group_customer_id = profile.customer_id
      WHERE profile.org_id = $1::uuid
      ORDER BY profile.customer_id
      FOR UPDATE OF profile`,
    [orgId, rootId],
  );
}

async function retireProfilePii(
  client: SqlClient,
  orgId: string,
  rootId: string,
  at: Date,
): Promise<void> {
  await client.query(
    `UPDATE customer_addresses address_row
        SET label = NULL, recipient = NULL, contact_phone = NULL, address_body = NULL,
            retired_at = $3, pii_purged_at = $3, updated_at = $3
      WHERE address_row.org_id = $1::uuid AND address_row.retired_at IS NULL
        AND NOT address_row.portal_managed
        AND address_row.customer_id IN (
          SELECT group_customer_id FROM customer_canonical_group($2::uuid)
        )`,
    [orgId, rootId, at],
  );
  await client.query(
    `UPDATE customer_identifiers identifier_row
        SET raw_value = NULL, normalized_value = NULL,
            retired_at = $3, pii_purged_at = $3, updated_at = $3
      WHERE identifier_row.org_id = $1::uuid AND identifier_row.retired_at IS NULL
        AND identifier_row.customer_id IN (
          SELECT group_customer_id FROM customer_canonical_group($2::uuid)
        )`,
    [orgId, rootId, at],
  );
}

async function writeProfile(
  client: SqlClient,
  orgId: string,
  rootId: string,
  input: CustomerProfileSetStoreInput,
  newId: () => string,
): Promise<CustomerProfileView | null> {
  await lockProfileGroup(client, orgId, rootId);
  const current = await loadProfileRow(client, orgId, rootId);
  if ((current?.version ?? 0) !== input.expected_version) return null;
  const version = input.expected_version + 1;
  const at = new Date(input.at * 1000);
  await retireProfilePii(client, orgId, rootId, at);
  await client.query(
    `INSERT INTO customer_profiles (
       org_id, customer_id, version, gender, preferred_contact, service_note,
       skip_ticket_print, skip_label_print, skip_rack_assignment, discount_bps,
       origin_store_id, updated_by_staff_id, created_at, updated_at
     ) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11::uuid,$12::uuid,$13,$13)
     ON CONFLICT (org_id, customer_id) DO UPDATE SET
       version=EXCLUDED.version, gender=EXCLUDED.gender,
       preferred_contact=EXCLUDED.preferred_contact, service_note=EXCLUDED.service_note,
       skip_ticket_print=EXCLUDED.skip_ticket_print,
       skip_label_print=EXCLUDED.skip_label_print,
       skip_rack_assignment=EXCLUDED.skip_rack_assignment,
       discount_bps=EXCLUDED.discount_bps, origin_store_id=EXCLUDED.origin_store_id,
       updated_by_staff_id=EXCLUDED.updated_by_staff_id, updated_at=EXCLUDED.updated_at`,
    [
      orgId,
      rootId,
      version,
      input.gender,
      input.preferred_contact,
      input.service_note,
      input.waivers.skip_ticket_print,
      input.waivers.skip_label_print,
      input.waivers.skip_rack_assignment,
      current?.discount_bps ?? null,
      input.store_id,
      input.staff_id,
      at,
    ],
  );
  for (const address of input.addresses) {
    await client.query(
      `INSERT INTO customer_addresses (
         id, org_id, customer_id, profile_version, label, recipient,
         contact_phone, address_body, is_default, created_at, updated_at
       ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$10)`,
      [
        newId(),
        orgId,
        rootId,
        version,
        address.label,
        address.recipient,
        address.contact_phone,
        address.address,
        address.is_default,
        at,
      ],
    );
  }
  for (const identifier of input.identifiers) {
    await client.query(
      `INSERT INTO customer_identifiers (
         id, org_id, customer_id, profile_version, kind, raw_value,
         normalized_value, created_at, updated_at
       ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$8)`,
      [
        newId(),
        orgId,
        rootId,
        version,
        identifier.kind,
        identifier.value,
        normalizeCustomerIdentifier(identifier.value),
        at,
      ],
    );
  }
  return loadProfile(client, orgId, rootId);
}

async function writeDiscount(
  client: SqlClient,
  orgId: string,
  rootId: string,
  input: CustomerDiscountSetStoreInput,
): Promise<CustomerProfileView | null> {
  await lockProfileGroup(client, orgId, rootId);
  const current = await loadProfileRow(client, orgId, rootId);
  if ((current?.version ?? 0) !== input.expected_version) return null;
  const ownerId = current?.customer_id ?? rootId;
  const at = new Date(input.at * 1000);
  await client.query(
    `INSERT INTO customer_profiles (
       org_id, customer_id, version, gender, preferred_contact, service_note,
       skip_ticket_print, skip_label_print, skip_rack_assignment, discount_bps,
       origin_store_id, updated_by_staff_id, created_at, updated_at
     ) VALUES ($1::uuid,$2::uuid,1,'unspecified','none',NULL,false,false,false,$3,
               $4::uuid,$5::uuid,$6,$6)
     ON CONFLICT (org_id, customer_id) DO UPDATE SET
       version=customer_profiles.version + 1, discount_bps=EXCLUDED.discount_bps,
       origin_store_id=EXCLUDED.origin_store_id,
       updated_by_staff_id=EXCLUDED.updated_by_staff_id, updated_at=EXCLUDED.updated_at`,
    [orgId, ownerId, input.discount_bps, input.store_id, input.staff_id, at],
  );
  return loadProfile(client, orgId, rootId);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export function createPgCustomerProfileStore(
  pool: PgPool,
  options: Readonly<{ orgId: string; newId?: () => string }>,
): CustomerProfileStore {
  const newId = options.newId ?? randomUUID;
  return Object.freeze({
    get: (customerId) =>
      withOrgGucOrCurrent(pool, { orgId: options.orgId }, async (client) => {
        const rootId = await resolveRoot(client, options.orgId, customerId, false);
        return rootId === null ? null : loadProfile(client, options.orgId, rootId);
      }),
    getForOrder: (customerId) =>
      withOrgGucOrCurrent(pool, { orgId: options.orgId }, async (client) => {
        const rootId = await resolveRoot(client, options.orgId, customerId, true);
        if (rootId === null) return null;
        await lockProfileGroup(client, options.orgId, rootId);
        return loadProfile(client, options.orgId, rootId);
      }),
    findCustomerIdsByIdentifier: (value) =>
      withOrgGucOrCurrent(pool, { orgId: options.orgId }, async (client) => {
        const result = await client.query<Readonly<{ customer_id: string }>>(
          `SELECT DISTINCT customer_canonical_root(identifier_row.customer_id)::text AS customer_id
             FROM customer_identifiers identifier_row
            WHERE identifier_row.org_id = $1::uuid
              AND identifier_row.retired_at IS NULL
              AND identifier_row.normalized_value = $2
            ORDER BY customer_id
            LIMIT 50`,
          [options.orgId, normalizeCustomerIdentifier(value)],
        );
        return Object.freeze(result.rows.map((row) => row.customer_id));
      }),
    setProfile: (input) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: options.orgId, storeId: input.store_id, staffId: input.staff_id },
        async (client) => {
          const rootId = await resolveRoot(client, options.orgId, input.customer_id, true);
          if (rootId === null) return null;
          try {
            return await writeProfile(client, options.orgId, rootId, input, newId);
          } catch (error) {
            if (isUniqueViolation(error)) throw new CustomerIdentifierConflictError();
            throw error;
          }
        },
      ),
    setDiscount: (input) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: options.orgId, storeId: input.store_id, staffId: input.staff_id },
        async (client) => {
          const rootId = await resolveRoot(client, options.orgId, input.customer_id, true);
          return rootId === null ? null : writeDiscount(client, options.orgId, rootId, input);
        },
      ),
  });
}
