import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryLocalRuntime } from "../local/demo-seed.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { createReadonlyAssistantTool } from "./readonly-assistant-tool.js";
import type { AiRequestContext } from "./streaming-store.js";

const context = (permissions: readonly string[]): AiRequestContext =>
  Object.freeze({
    tenant: Object.freeze({
      orgId: LOCAL_PROFILE.orgId,
      storeId: LOCAL_PROFILE.storeId,
      staffId: LOCAL_PROFILE.adminStaffId,
    }),
    authSessionId: "44444444-4444-4444-8444-444444444444",
    deviceId: "55555555-5555-4555-8555-555555555555",
    permissions: Object.freeze([...permissions]),
  });

test("three assistant tools return bounded sources and explicit redacted filters", async () => {
  const tool = createReadonlyAssistantTool(await createMemoryLocalRuntime());
  const signal = new AbortController().signal;
  const business = await tool.execute(
    { tool: "business.summary", args: { business_date: "2026-08-13" } },
    context(["accounting_read"]),
    signal,
  );
  const records = await tool.execute(
    { tool: "records.search", args: { scope: "customers", query: "138", limit: 5 } },
    context(["customer_read"]),
    signal,
  );
  const procedure = await tool.execute(
    { tool: "procedure.troubleshoot", args: { topic: "printing", symptom: "手机号13800000001" } },
    context(["ai_use"]),
    signal,
  );

  assert.equal(business.sources[0]?.ref, "query:stats.day.summary:0.3.0");
  assert.equal(records.filters[0]?.value, "redacted");
  assert.doesNotMatch(JSON.stringify(records), /13800000001/u);
  assert.equal(procedure.sources[0]?.kind, "document");
  assert.match(procedure.summary, /脱敏 1 处/u);
});

test("tool RBAC fails closed before a business query", async () => {
  const tool = createReadonlyAssistantTool(await createMemoryLocalRuntime());
  await assert.rejects(
    () =>
      tool.execute(
        { tool: "business.summary", args: {} },
        context(["ai_use"]),
        new AbortController().signal,
      ),
    /AI_TOOL_PERMISSION_DENIED/u,
  );
});
