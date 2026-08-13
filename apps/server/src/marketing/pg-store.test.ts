import assert from "node:assert/strict";
import test from "node:test";

import type { MarketingCampaignSetInput } from "@laundry/contracts";

import type { QueryResult, SqlClient, TenantContext } from "../db/types.js";
import { createPgMarketingStore } from "./pg-store.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CAMPAIGN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CUSTOMER_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CUSTOMER_B = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const NOW = new Date("2026-08-13T02:00:00.000Z");
const RULE = Object.freeze({
  customer_age: Object.freeze({ kind: "within_days" as const, days: 90 }),
  order_activity: Object.freeze({ kind: "none" as const }),
  membership: Object.freeze({ kind: "non_member" as const }),
});

const TENANT: TenantContext = Object.freeze({
  orgId: ORG_ID,
  storeId: STORE_ID,
  staffId: STAFF_ID,
});
const CAMPAIGN_ROW = Object.freeze({
  id: CAMPAIGN_ID,
  code: "summer_26",
  name: "夏季回访",
  status: "draft" as const,
  starts_at: "2026-08-14T00:00:00.000Z",
  ends_at: "2026-09-14T00:00:00.000Z",
  audience_rule: RULE,
  audience_rule_sha256: "a".repeat(64),
  recipient_limit: 2,
  budget_limit_cents: 50_000,
  budget_used_cents: 0,
  version: 1,
  updated_at: NOW.toISOString(),
});

type Call = Readonly<{ sql: string; params: readonly unknown[] | undefined }>;

class ScriptedClient implements SqlClient {
  readonly calls: Call[] = [];
  private index = 0;

  constructor(private readonly responses: readonly (readonly unknown[])[]) {}

  async query<TRow = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<TRow>> {
    this.calls.push(Object.freeze({ sql, params }));
    const rows = (this.responses[this.index] ?? []) as readonly TRow[];
    this.index += 1;
    return Object.freeze({ rows, rowCount: rows.length });
  }
}

test("PG audience preview uses one fixed parameterized query and returns no recipients", async () => {
  const client = new ScriptedClient([
    [CAMPAIGN_ROW],
    [
      { customer_id: CUSTOMER_A, matched_count: 3 },
      { customer_id: CUSTOMER_B, matched_count: 3 },
    ],
  ]);
  const preview = await createPgMarketingStore().previewAudience(
    client,
    TENANT,
    CAMPAIGN_ID,
    1,
    NOW,
  );

  assert.notEqual(preview, null);
  assert.equal(preview?.recipientCount, 2);
  assert.equal(preview?.matchedCount, 3);
  assert.equal(JSON.stringify(preview).includes(CUSTOMER_A), false);
  assert.equal(JSON.stringify(preview).includes(CUSTOMER_B), false);
  assert.match(client.calls[1]?.sql ?? "", /customer_row\.org_id = \$1/u);
  assert.match(client.calls[1]?.sql ?? "", /order_row\.store_id = \$2/u);
  assert.deepEqual(client.calls[1]?.params, [
    ORG_ID,
    STORE_ID,
    NOW.toISOString(),
    "within_days",
    90,
    "none",
    null,
    "non_member",
    [],
    2,
  ]);
});

test("PG campaign update refuses a different immutable code before issuing UPDATE", async () => {
  const client = new ScriptedClient([[CAMPAIGN_ROW]]);
  const input: MarketingCampaignSetInput = Object.freeze({
    campaign_id: CAMPAIGN_ID,
    expected_version: 1,
    code: "changed_code",
    name: "夏季回访",
    status: "draft",
    starts_at: "2026-08-14T00:00:00.000Z",
    ends_at: "2026-09-14T00:00:00.000Z",
    budget_limit_cents: 50_000,
    recipient_limit: 2,
    audience_rule: RULE,
  });
  const result = await createPgMarketingStore().setCampaign(client, TENANT, {
    ...input,
    at: NOW,
  });

  assert.deepEqual(result, { ok: false, reason: "conflict" });
  assert.equal(client.calls.length, 1);
  assert.doesNotMatch(client.calls[0]?.sql ?? "", /\bUPDATE campaigns\b/u);
});
