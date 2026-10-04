import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AiOperationDraftSchema } from "@laundry/contracts";
import { createMemoryLocalRuntime } from "../local/demo-seed.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { createMemoryFulfillmentStore } from "../fulfillment/memory-store.js";
import type { AuthorizedSession } from "../auth/session-view.js";
import { permissionsForAuthority } from "../bus/runtime.js";
import { previewAssistantOperation, confirmAssistantOperation } from "./assistant-operations.js";
import { createReadonlyAssistantTool } from "./readonly-assistant-tool.js";

const ids = [randomUUID(), randomUUID()];
async function fixture() {
  const base = await createMemoryLocalRuntime();
  const now = Math.floor(Date.now() / 1000);
  const store = createMemoryFulfillmentStore({
    garments: ids.map((id, index) => ({
      org_id: LOCAL_PROFILE.orgId,
      store_id: LOCAL_PROFILE.storeId,
      garment_id: id,
      order_id: randomUUID(),
      ticket_no: `TEST-${index}`,
      barcode: `BAR-${index}`,
      customer_name: "PRIVATE_NAME",
      customer_phone_masked: "13800000001",
      service_code: "wash",
      category_code: "shirt",
      color: "白色",
      brand: null,
      status: "washing" as const,
      rack_zone: null,
      rack_slot: null,
      updated_at: now,
      incident_count: 0,
    })),
  });
  const runtime = {
    ...base,
    fulfillment: { ...base.fulfillment, store, now: () => now, featureEnabled: async () => true },
  };
  const authorized: AuthorizedSession = {
    session: {
      session_id: randomUUID(),
      session_version: 1,
      org_id: LOCAL_PROFILE.orgId,
      store_id: LOCAL_PROFILE.storeId,
      staff_id: LOCAL_PROFILE.adminStaffId,
      device_id: randomUUID(),
      permission_version: 1,
      authentication_method: "password",
      status: "active",
      family_id: randomUUID(),
      created_at: now,
      revoked_at: null,
    },
    authority: {
      staff_id: LOCAL_PROFILE.adminStaffId,
      display_name: "Fixture",
      role: "admin",
      permission_version: 1,
      is_privacy_admin: false,
    },
  };
  const context = {
    tenant: {
      orgId: LOCAL_PROFILE.orgId,
      storeId: LOCAL_PROFILE.storeId,
      staffId: LOCAL_PROFILE.adminStaffId,
    },
    authSessionId: authorized.session.session_id,
    deviceId: authorized.session.device_id,
    permissions: permissionsForAuthority(authorized.authority),
  };
  return { runtime, store, context, authorized };
}

test("AI previews without mutation; explicit confirmation executes frozen R3 input once", async () => {
  const { runtime, store, context, authorized } = await fixture();
  const card = await previewAssistantOperation(
    runtime,
    {
      command: "garment.bulk_transition",
      input: { garment_ids: ids, target_status: "ready", note: "检查完成" },
    },
    context,
    AbortSignal.timeout(3000),
  );
  assert.match(card.summary, /BAR-0/u);
  assert.doesNotMatch(card.summary, /PRIVATE_NAME|13800000001/u);
  const search = () =>
    store.listWorkbench(context.tenant.orgId, context.tenant.storeId, { limit: 10 });
  assert.equal(
    (await search()).every((row) => row.status === "washing"),
    true,
  );
  const result = await confirmAssistantOperation(runtime, authorized, card.confirm_ref);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(
    (await search()).every((row) => row.status === "ready"),
    true,
  );
  const second = await confirmAssistantOperation(runtime, authorized, card.confirm_ref);
  assert.deepEqual(second, result);
  assert.equal(
    (await search()).every((row) => row.status === "ready"),
    true,
  );
});

test("AI operations reject arbitrary commands, extra fields, foreign tenant and absent permissions", async () => {
  const { runtime, context } = await fixture();
  assert.equal(
    AiOperationDraftSchema.safeParse({ command: "notification.delivery_batch.enqueue", input: {} })
      .success,
    false,
  );
  assert.equal(
    AiOperationDraftSchema.safeParse({
      command: "garment.rework",
      input: { garment_ids: ids, reason: "test", sql: "SELECT 1" },
    }).success,
    false,
  );
  const draft = {
    command: "garment.bulk_transition",
    input: { garment_ids: ids, target_status: "ready" },
  };
  await assert.rejects(
    previewAssistantOperation(
      runtime,
      draft,
      { ...context, permissions: ["ai_use"] },
      AbortSignal.timeout(3000),
    ),
  );
  await assert.rejects(
    previewAssistantOperation(
      runtime,
      draft,
      { ...context, tenant: { ...context.tenant, storeId: randomUUID() } },
      AbortSignal.timeout(3000),
    ),
  );
  await assert.rejects(
    previewAssistantOperation(
      runtime,
      { command: "garment.rework", input: { garment_ids: ids, reason: "联系13800000001" } },
      context,
      AbortSignal.timeout(3000),
    ),
  );
});

test("AI garment search emits scoped identity and state without customer PII", async () => {
  const { runtime, context } = await fixture();
  const result = await createReadonlyAssistantTool(runtime).execute(
    { tool: "records.search", args: { scope: "garments", query: "BAR", limit: 5 } },
    context,
    AbortSignal.timeout(3000),
  );
  assert.equal(result.result_count, 2);
  assert.equal(result.items[0]?.garment_id !== undefined, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_NAME|13800000001/u);
});
