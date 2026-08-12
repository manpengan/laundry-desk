import assert from "node:assert/strict";
import test from "node:test";

import type { QueryResult, SqlClient, TenantContext } from "../db/types.js";
import { audienceDigest } from "./audience.js";
import {
  couponIssueConfirmationSummary,
  couponReversalConfirmationSummary,
} from "./coupon-authority.js";
import { createPgMarketingStore } from "./pg-store.js";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CAMPAIGN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SNAPSHOT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const COUPON = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const CUSTOMER_A = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_B = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_A = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-08-13T02:00:00.000Z");
const RULE = Object.freeze({
  customer_age: Object.freeze({ kind: "any" as const }),
  order_activity: Object.freeze({ kind: "any" as const }),
  membership: Object.freeze({ kind: "any" as const }),
});
const RULE_DIGEST = "a".repeat(64);
const AUDIENCE_DIGEST = audienceDigest(CAMPAIGN, 1, RULE_DIGEST, [CUSTOMER_A, CUSTOMER_B]);
const TENANT: TenantContext = Object.freeze({ orgId: ORG, storeId: STORE, staffId: STAFF });
const CAMPAIGN_ROW = Object.freeze({
  id: CAMPAIGN,
  code: "august_return",
  name: "八月回访",
  status: "scheduled" as const,
  starts_at: "2026-08-13T00:00:00.000Z",
  ends_at: "2026-08-14T00:00:00.000Z",
  audience_rule: RULE,
  audience_rule_sha256: RULE_DIGEST,
  recipient_limit: 10,
  budget_limit_cents: 10_000,
  budget_used_cents: 1_000,
  version: 1,
  updated_at: NOW.toISOString(),
});
const SNAPSHOT_ROW = Object.freeze({
  id: SNAPSHOT,
  campaign_id: CAMPAIGN,
  campaign_version: 1,
  audience_digest: AUDIENCE_DIGEST,
  recipient_count: 2,
});
type CouponFixture = Readonly<{
  id: string;
  code: string;
  name: string;
  discount_cents: number;
  min_order_cents: number;
  valid_days: number;
  version: number;
  status: string;
}>;
const COUPON_ROW: CouponFixture = Object.freeze({
  id: COUPON,
  code: "return_5",
  name: "回访五元券",
  discount_cents: 500,
  min_order_cents: 2_000,
  valid_days: 30,
  version: 1,
  status: "active",
});

type Call = Readonly<{ sql: string; params: readonly unknown[] | undefined }>;
class ScriptedClient implements SqlClient {
  readonly calls: Call[] = [];
  private cursor = 0;
  constructor(private readonly responses: readonly (readonly unknown[])[]) {}
  async query<TRow = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<TRow>> {
    this.calls.push(Object.freeze({ sql, params }));
    const rows = (this.responses[this.cursor] ?? []) as readonly TRow[];
    this.cursor += 1;
    return Object.freeze({ rows, rowCount: rows.length });
  }
}

function authorityResponses(
  options: Readonly<{
    lock?: boolean;
    coupon?: CouponFixture;
    budgetUsedCents?: number;
  }> = {},
): readonly (readonly unknown[])[] {
  const authorityRows: (readonly unknown[])[] = [
    [SNAPSHOT_ROW],
    [
      { customer_id: CUSTOMER_A, matched_count: 2 },
      { customer_id: CUSTOMER_B, matched_count: 2 },
    ],
    [options.coupon ?? COUPON_ROW],
    [{ account_id: ACCOUNT_A, customer_id: CUSTOMER_A }],
  ];
  return Object.freeze(
    options.lock === true
      ? [
          [CAMPAIGN_ROW],
          [{ budget_used_cents: options.budgetUsedCents ?? 1_000 }],
          ...authorityRows,
        ]
      : [[CAMPAIGN_ROW], ...authorityRows],
  );
}

test("PG coupon preview re-evaluates the frozen digest and exposes aggregate eligibility only", async () => {
  const client = new ScriptedClient(authorityResponses());
  const result = await createPgMarketingStore().previewCouponIssue(client, TENANT, {
    campaign_id: CAMPAIGN,
    expected_version: 1,
    snapshot_id: SNAPSHOT,
    coupon_definition_id: COUPON,
    at: NOW,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.preview.audience_recipient_count, 2);
  assert.equal(result.preview.eligible_recipient_count, 1);
  assert.equal(result.preview.ineligible_recipient_count, 1);
  assert.equal(result.preview.budget_required_cents, 500);
  assert.equal(JSON.stringify(result.preview).includes(CUSTOMER_A), false);
  assert.equal(JSON.stringify(result.preview).includes(ACCOUNT_A), false);
  assert.deepEqual(client.calls[4]?.params, [ORG, [CUSTOMER_A, CUSTOMER_B]]);
});

const INPUT = Object.freeze({
  campaign_id: CAMPAIGN,
  expected_version: 1,
  snapshot_id: SNAPSHOT,
  coupon_definition_id: COUPON,
  reason: "八月回访",
});

function frozenPreview(budgetRemainingCents: number) {
  return couponIssueConfirmationSummary(INPUT, {
    campaign_id: CAMPAIGN,
    campaign_version: 1,
    snapshot_id: SNAPSHOT,
    audience_digest: AUDIENCE_DIGEST,
    coupon_definition_id: COUPON,
    coupon_version: 1,
    coupon_code: "return_5",
    coupon_name: "回访五元券",
    coupon_discount_cents: 500,
    coupon_min_order_cents: 2_000,
    coupon_valid_days: 30,
    audience_recipient_count: 2,
    eligible_recipient_count: 1,
    ineligible_recipient_count: 1,
    budget_required_cents: 500,
    budget_remaining_cents: budgetRemainingCents,
    evaluated_at: NOW.toISOString(),
  });
}

test("PG coupon issue locks the campaign before recomputing budget and rejects drift", async () => {
  const client = new ScriptedClient([[], ...authorityResponses({ lock: true })]);
  const result = await createPgMarketingStore().issueCoupons(client, TENANT, {
    ...INPUT,
    at: NOW,
    frozenAuthority: frozenPreview(8_000),
  });
  assert.deepEqual(result, { ok: false, reason: "authority_drift" });
  assert.match(client.calls[1]?.sql ?? "", /FOR UPDATE OF campaign/u);
  assert.doesNotMatch(client.calls[1]?.sql ?? "", /campaign_budget_ledger/u);
  assert.match(client.calls[2]?.sql ?? "", /FROM campaign_budget_ledger/u);
  assert.equal(
    client.calls.some((call) => /INSERT INTO campaign_coupon_batches/u.test(call.sql)),
    false,
  );
});

for (const drift of [
  Object.freeze({ label: "version", coupon: Object.freeze({ ...COUPON_ROW, version: 2 }) }),
  Object.freeze({
    label: "minimum",
    coupon: Object.freeze({ ...COUPON_ROW, min_order_cents: 2_500 }),
  }),
  Object.freeze({ label: "validity", coupon: Object.freeze({ ...COUPON_ROW, valid_days: 31 }) }),
]) {
  test(`PG coupon issue rejects frozen coupon ${drift.label} drift`, async () => {
    const client = new ScriptedClient([
      [],
      ...authorityResponses({ lock: true, coupon: drift.coupon }),
    ]);
    const result = await createPgMarketingStore().issueCoupons(client, TENANT, {
      ...INPUT,
      at: NOW,
      frozenAuthority: frozenPreview(9_000),
    });
    assert.deepEqual(result, { ok: false, reason: "authority_drift" });
    assert.equal(
      client.calls.some((call) => /INSERT INTO campaign_coupon_batches/u.test(call.sql)),
      false,
    );
  });
}

test("PG coupon issue writes grants, provenance and exact budget once", async () => {
  const ids = [
    "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
    "77777777-7777-4777-8777-777777777777",
  ];
  const client = new ScriptedClient([
    [],
    ...authorityResponses({ lock: true }),
    [],
    [{ created_at: NOW.toISOString() }],
    [{ value: "2026-08-13" }],
    [],
    [],
    [],
  ]);
  const result = await createPgMarketingStore({ newId: () => ids.shift()! }).issueCoupons(
    client,
    TENANT,
    {
      ...INPUT,
      at: NOW,
      frozenAuthority: frozenPreview(9_000),
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.batch.granted_count, 1);
  assert.equal(result.batch.budget_committed_cents, 500);
  assert.equal(result.batch.replayed, false);
  assert.equal(
    client.calls.filter((call) => /INSERT INTO coupon_grants/u.test(call.sql)).length,
    1,
  );
  assert.equal(
    client.calls.filter((call) => /INSERT INTO campaign_coupon_grants/u.test(call.sql)).length,
    1,
  );
  const budget = client.calls.find((call) => /INSERT INTO campaign_budget_ledger/u.test(call.sql));
  assert.equal(budget?.params?.[5], 500);
});

test("PG campaign coupon correction restores an unpaid order and appends a reversal", async () => {
  const redemption = "88888888-8888-4888-8888-888888888888";
  const grant = "99999999-9999-4999-8999-999999999999";
  const order = "12121212-1212-4121-8121-121212121212";
  const reversal = "13131313-1313-4131-8131-131313131313";
  const client = new ScriptedClient([
    [{ id: order }],
    [
      {
        redemption_id: redemption,
        grant_id: grant,
        order_id: order,
        discount_cents: 500,
        campaign_grant_id: "14141414-1414-4141-8141-141414141414",
        reversal_id: null,
        reversal_at: null,
        order_status: "open",
        paid_cents: 0,
        order_discount_cents: 500,
      },
    ],
    [{}],
    [{ at: NOW.toISOString() }],
  ]);
  const result = await createPgMarketingStore({ newId: () => reversal }).reverseCouponRedemption(
    client,
    TENANT,
    {
      redemptionId: redemption,
      reason: "顾客误用",
      at: NOW,
      frozenAuthority: couponReversalConfirmationSummary(
        { redemption_id: redemption, reason: "顾客误用" },
        {
          redemptionId: redemption,
          grantId: grant,
          orderId: order,
          discountCents: 500,
          alreadyReversed: false,
        },
      ),
    },
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.reversal.changed, true);
  assert.equal(result.reversal.reversal_id, reversal);
  assert.match(client.calls[0]?.sql ?? "", /FOR UPDATE OF order_row/u);
  assert.match(client.calls[2]?.sql ?? "", /payable_cents=payable_cents\+\$4/u);
  assert.match(client.calls[3]?.sql ?? "", /INSERT INTO coupon_redemption_reversals/u);
  assert.doesNotMatch(client.calls.map((call) => call.sql).join("\n"), /DELETE FROM coupon_/u);
});

test("PG campaign coupon correction returns existing evidence after taking the order lock", async () => {
  const redemption = "88888888-8888-4888-8888-888888888888";
  const grant = "99999999-9999-4999-8999-999999999999";
  const order = "12121212-1212-4121-8121-121212121212";
  const reversal = "13131313-1313-4131-8131-131313131313";
  const client = new ScriptedClient([
    [{ id: order }],
    [
      {
        redemption_id: redemption,
        grant_id: grant,
        order_id: order,
        discount_cents: 500,
        campaign_grant_id: "14141414-1414-4141-8141-141414141414",
        reversal_id: reversal,
        reversal_at: NOW.toISOString(),
        order_status: "open",
        paid_cents: 0,
        order_discount_cents: 0,
      },
    ],
  ]);
  const result = await createPgMarketingStore().reverseCouponRedemption(client, TENANT, {
    redemptionId: redemption,
    reason: "重复请求",
    at: NOW,
    frozenAuthority: couponReversalConfirmationSummary(
      { redemption_id: redemption, reason: "重复请求" },
      {
        redemptionId: redemption,
        grantId: grant,
        orderId: order,
        discountCents: 500,
        alreadyReversed: true,
      },
    ),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.reversal.changed, false);
  assert.equal(result.reversal.reversal_id, reversal);
  assert.equal(client.calls.length, 2);
});

test("PG coupon correction fails closed when its frozen order amount drifted", async () => {
  const redemption = "88888888-8888-4888-8888-888888888888";
  const grant = "99999999-9999-4999-8999-999999999999";
  const order = "12121212-1212-4121-8121-121212121212";
  const client = new ScriptedClient([
    [{ id: order }],
    [
      {
        redemption_id: redemption,
        grant_id: grant,
        order_id: order,
        discount_cents: 500,
        campaign_grant_id: "14141414-1414-4141-8141-141414141414",
        reversal_id: null,
        reversal_at: null,
        order_status: "open",
        paid_cents: 0,
        order_discount_cents: 500,
      },
    ],
  ]);
  const result = await createPgMarketingStore().reverseCouponRedemption(client, TENANT, {
    redemptionId: redemption,
    reason: "顾客误用",
    at: NOW,
    frozenAuthority: couponReversalConfirmationSummary(
      { redemption_id: redemption, reason: "顾客误用" },
      {
        redemptionId: redemption,
        grantId: grant,
        orderId: order,
        discountCents: 400,
        alreadyReversed: false,
      },
    ),
  });
  assert.deepEqual(result, { ok: false, reason: "authority_drift" });
  assert.equal(
    client.calls.some((call) => /^UPDATE orders/u.test(call.sql.trim())),
    false,
  );
});
