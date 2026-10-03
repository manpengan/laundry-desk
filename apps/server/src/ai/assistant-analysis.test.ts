import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryLocalRuntime } from "../local/demo-seed.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { createReadonlyAssistantTool } from "./readonly-assistant-tool.js";
import { assistantPickup } from "./assistant-analysis.js";

test("business trend exposes dates, separate accounting bases and bounded summary", async () => {
  const tool = createReadonlyAssistantTool(await createMemoryLocalRuntime());
  const context = {
    tenant: {
      orgId: LOCAL_PROFILE.orgId,
      storeId: LOCAL_PROFILE.storeId,
      staffId: LOCAL_PROFILE.adminStaffId,
    },
    authSessionId: "44444444-4444-4444-8444-444444444444",
    deviceId: "55555555-5555-4555-8555-555555555555",
    permissions: ["accounting_read"],
  };
  const result = await tool.execute(
    { tool: "business.trend", args: { days: 7 } },
    context,
    AbortSignal.timeout(3000),
  );
  assert.equal(result.items.length, 1);
  assert.equal(typeof result.items[0]?.performance_income_cents, "number");
  assert.match(result.summary, /不代表异常或利润/u);
  assert.equal(result.filters[0]?.value, "7");
  await assert.rejects(
    tool.execute(
      { tool: "business.trend", args: { days: 30 } },
      { ...context, permissions: ["ai_use"] },
      AbortSignal.timeout(3000),
    ),
  );
});

test("pickup projection omits all customer identity, bounds candidates and never implies contact", () => {
  const row = {
    order_id: "44444444-4444-4444-8444-444444444444",
    ticket_no: "SYNTHETIC",
    customer_id: null,
    customer_name: "PRIVATE",
    customer_phone: "13800000001",
    garment_count: 1,
    balance_cents: 100,
    received_at: "2026-01-01T00:00:00.000Z",
    overdue_days: 90,
    garment_statuses: ["ready"],
    last_contact_at: null,
  };
  const result = assistantPickup(
    {
      generated_at: "2026-10-03T00:00:00.000Z",
      channels: { manual: true, sms: false, wechat: false },
      candidates: [row, row],
    },
    { tool: "pickup.candidates", args: { limit: 1, min_age_days: 30, unpaid_only: false } },
  );
  assert.equal(result.result_count, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|13800000001/u);
  assert.match(result.summary, /尚未联系/u);
  assert.throws(() =>
    assistantPickup(
      {},
      { tool: "pickup.candidates", args: { limit: 1, min_age_days: 30, unpaid_only: false } },
    ),
  );
});
