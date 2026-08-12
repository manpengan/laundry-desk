import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import type { ActorContext, TransactionalIdempotencyStore } from "../bus/types.js";
import { createMemoryCustomerStore } from "../customer/memory-store.js";
import { CustomerErasedError } from "../customer/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createDefaultChainHooks } from "../handlers/default-chain-hooks.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";
import { CustomerIdentifierConflictError, type CustomerProfileSetStoreInput } from "./types.js";
import { createMemoryCustomerProfileStore } from "./memory-store.js";

const ORG_ID = "10000000-0000-4000-8000-000000000001";
const STORE_ID = "10000000-0000-4000-8000-000000000002";
const STAFF_ID = "10000000-0000-4000-8000-000000000003";
const CUSTOMER_A = "10000000-0000-4000-8000-000000000011";
const CUSTOMER_B = "10000000-0000-4000-8000-000000000012";
const CUSTOMER_C = "10000000-0000-4000-8000-000000000013";

const TENANT: TenantContext = Object.freeze({
  orgId: ORG_ID,
  storeId: STORE_ID,
  staffId: STAFF_ID,
});

const PRIVACY_ADMIN: ActorContext = Object.freeze({
  staffId: STAFF_ID,
  deviceId: null,
  via: "ui",
  permissions: Object.freeze([
    "customer_read",
    "customer_write",
    "order_discount",
    "privacy_admin",
  ]),
});

function profileInput(
  customerId: string,
  overrides: Partial<CustomerProfileSetStoreInput> = {},
): CustomerProfileSetStoreInput {
  const input: CustomerProfileSetStoreInput = {
    customer_id: customerId,
    expected_version: 0,
    gender: "unspecified",
    preferred_contact: "wechat",
    service_note: "synthetic private service note",
    waivers: Object.freeze({
      skip_ticket_print: true,
      skip_label_print: false,
      skip_rack_assignment: true,
    }),
    addresses: [
      {
        label: "office",
        recipient: "Synthetic Customer",
        contact_phone: "+86 138 0000 0000",
        address: "Synthetic Road 1",
        is_default: true,
      },
    ],
    identifiers: [{ kind: "vehicle_plate", value: "TEST-A123" }],
    reason: "synthetic profile update",
    store_id: STORE_ID,
    staff_id: STAFF_ID,
    at: 1_800_000_000,
    ...overrides,
  };
  return Object.freeze(input);
}

async function seedCustomers() {
  const customers = createMemoryCustomerStore([]);
  await customers.upsert({
    customer_id: CUSTOMER_A,
    phone: "13800000001",
    name: "Synthetic A",
    now: 100,
  });
  await customers.upsert({
    customer_id: CUSTOMER_B,
    phone: "13800000002",
    name: "Synthetic B",
    now: 100,
  });
  return customers;
}

test("memory profile is read-without-write version zero and enforces CAS", async () => {
  const customers = await seedCustomers();
  const ids = ["20000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002"];
  const profiles = createMemoryCustomerProfileStore(customers, () => ids.shift()!);

  const empty = await profiles.get(CUSTOMER_A);
  assert.equal(empty?.version, 0);
  assert.deepEqual(empty?.addresses, []);

  const saved = await profiles.setProfile(profileInput(CUSTOMER_A));
  assert.equal(saved?.version, 1);
  assert.equal(saved?.addresses[0]?.address_id, "20000000-0000-4000-8000-000000000001");
  assert.equal(saved?.identifiers[0]?.identifier_id, "20000000-0000-4000-8000-000000000002");
  assert.equal(await profiles.setProfile(profileInput(CUSTOMER_A)), null);
});

test("normalized identifiers stay unique per kind and search returns every cross-kind match", async () => {
  const customers = await seedCustomers();
  let cursor = 0;
  const profiles = createMemoryCustomerProfileStore(
    customers,
    () => `30000000-0000-4000-8000-${String(++cursor).padStart(12, "0")}`,
  );
  assert.ok(await profiles.setProfile(profileInput(CUSTOMER_A)));
  assert.ok(
    await profiles.setProfile(
      profileInput(CUSTOMER_B, {
        identifiers: [{ kind: "tag", value: " test a123 " }],
      }),
    ),
  );

  assert.deepEqual(await profiles.findCustomerIdsByIdentifier?.("TEST-A123"), [
    CUSTOMER_A,
    CUSTOMER_B,
  ]);
  await assert.rejects(
    () =>
      profiles.setProfile(
        profileInput(CUSTOMER_B, {
          expected_version: 1,
          identifiers: [{ kind: "vehicle_plate", value: "test a 123" }],
        }),
      ),
    CustomerIdentifierConflictError,
  );
});

test("profile audit excludes address, identifier and service-note PII", async () => {
  const customers = await seedCustomers();
  let cursor = 0;
  const profiles = createMemoryCustomerProfileStore(
    customers,
    () => `40000000-0000-4000-8000-${String(++cursor).padStart(12, "0")}`,
  );
  const { registry } = createRegisteredM1Bus({
    customer: Object.freeze({ store: customers, profile: profiles }),
    customerProfile: Object.freeze({ store: profiles, now: () => 1_800_000_000 }),
  });
  const pendingStore = new MemoryPendingActionStore();
  const client = new FakeSqlClient();
  const input = profileInput(CUSTOMER_A);
  const commandInput = Object.freeze({
    customer_id: input.customer_id,
    expected_version: input.expected_version,
    gender: input.gender,
    preferred_contact: input.preferred_contact,
    service_note: input.service_note,
    waivers: input.waivers,
    addresses: input.addresses,
    identifiers: input.identifiers,
    reason: input.reason,
  });
  const result = await executeCommand(client, TENANT, "customer.profile.set", commandInput, {
    registry,
    actor: PRIVACY_ADMIN,
    pendingStore,
    chainHooks: createDefaultChainHooks(
      {
        checkPolicy: async () =>
          Object.freeze({ ok: true as const, data: Object.freeze({ allowed: true as const }) }),
      },
      pendingStore,
    ),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const auditInsert = client.queries.find((query) => query.sql.includes("INSERT INTO audit_log"));
  const serialized = JSON.stringify(auditInsert?.params ?? []);
  for (const pii of ["Synthetic Road 1", "TEST-A123", "synthetic private service note"]) {
    assert.equal(serialized.includes(pii), false);
  }
  assert.match(serialized, /address_count/u);
});

test("privacy export and anonymization cover every profile in a merged memory group", async () => {
  const customers = await seedCustomers();
  let purgeCustomerId: string | null = null;
  let purgedGroupIds: readonly string[] = Object.freeze([]);
  const baseProfiles = createMemoryCustomerProfileStore(customers);
  await baseProfiles.setProfile(
    profileInput(CUSTOMER_A, {
      service_note: "Source private note",
      identifiers: [{ kind: "vehicle_plate", value: "TEST-A123" }],
      at: 1_800_000_001,
    }),
  );
  await baseProfiles.setProfile(
    profileInput(CUSTOMER_B, {
      service_note: "Target private note",
      identifiers: [{ kind: "vehicle_plate", value: "TEST-B456" }],
      at: 1_800_000_002,
    }),
  );
  assert.notEqual(
    await customers.merge({
      source_customer_id: CUSTOMER_A,
      target_customer_id: CUSTOMER_B,
      store_id: STORE_ID,
      staff_id: STAFF_ID,
      now: 1_800_000_003,
    }),
    null,
  );
  const profiles = Object.freeze({
    ...baseProfiles,
    purgeCustomerPii: async (customerId: string, canonicalGroupIds?: readonly string[]) => {
      purgeCustomerId = customerId;
      purgedGroupIds = Object.freeze([...(canonicalGroupIds ?? [])]);
      await baseProfiles.purgeCustomerPii?.(customerId, canonicalGroupIds);
    },
  });
  const { registry } = createRegisteredM1Bus({
    customer: Object.freeze({ store: customers, profile: profiles, now: () => 1_800_000_100 }),
    customerProfile: Object.freeze({ store: profiles }),
  });
  const forbiddenIdempotency: TransactionalIdempotencyStore = Object.freeze({
    lookup: async () => {
      throw new Error("privacy export must not lookup durable idempotency");
    },
    claim: async () => {
      throw new Error("privacy export must not claim durable idempotency");
    },
    complete: async () => {
      throw new Error("privacy export must not persist durable idempotency");
    },
  });
  const pendingStore = new MemoryPendingActionStore();
  const chainHooks = createDefaultChainHooks(
    {
      checkPolicy: async () =>
        Object.freeze({ ok: true as const, data: Object.freeze({ allowed: true as const }) }),
    },
    pendingStore,
  );
  const exported = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "customer.privacy.export",
    { customer_id: CUSTOMER_A, reason: "customer_request" },
    {
      registry,
      actor: PRIVACY_ADMIN,
      pendingStore,
      chainHooks,
      idempotencyStore: forbiddenIdempotency,
      idempotencyKey: "50000000-0000-4000-8000-000000000001",
    },
  );
  assert.equal(exported.ok, true, JSON.stringify(exported));
  if (exported.ok) {
    const body = exported.data.result as {
      format_version: number;
      profiles: readonly Readonly<{ customer_id: string; service_note: string | null }>[];
      addresses: readonly unknown[];
      identifiers: readonly unknown[];
    };
    assert.equal(body.format_version, 2);
    assert.deepEqual(
      body.profiles.map((profile) => [profile.customer_id, profile.service_note]),
      [
        [CUSTOMER_B, "Target private note"],
        [CUSTOMER_A, "Source private note"],
      ],
    );
    assert.equal(body.addresses.length, 2);
    assert.equal(body.identifiers.length, 2);
  }

  const anonymized = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "customer.anonymize",
    {
      customer_id: CUSTOMER_A,
      reason: "customer_request",
      confirmation: "ANONYMIZE",
    },
    { registry, actor: PRIVACY_ADMIN, pendingStore, chainHooks },
  );
  assert.equal(anonymized.ok, true, JSON.stringify(anonymized));
  assert.equal(purgeCustomerId, CUSTOMER_B);
  assert.deepEqual([...purgedGroupIds].sort(), [CUSTOMER_A, CUSTOMER_B]);
  await assert.rejects(
    () => customers.upsert({ phone: "13800000001", name: "Resurrected", now: 1_800_000_200 }),
    CustomerErasedError,
  );
  await assert.rejects(
    () => customers.upsert({ phone: "13800000002", name: "Resurrected", now: 1_800_000_200 }),
    CustomerErasedError,
  );

  await customers.upsert({
    customer_id: CUSTOMER_C,
    phone: "13800000003",
    name: "Synthetic C",
    now: 1_800_000_201,
  });
  assert.notEqual(
    await baseProfiles.setProfile(
      profileInput(CUSTOMER_C, {
        identifiers: [{ kind: "vehicle_plate", value: "TEST-A123" }],
        at: 1_800_000_202,
      }),
    ),
    null,
  );
});
