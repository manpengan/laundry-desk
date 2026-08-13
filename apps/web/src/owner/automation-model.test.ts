import assert from "node:assert/strict";
import test from "node:test";

import type { QueryPort } from "../commands/types.js";
import { buildAutomationDraft, loadAutomationPolicies } from "./automation-model.js";

test("automation form emits only the frozen allowlisted shape", () => {
  const result = buildAutomationDraft(
    {
      name: " 超期取件提醒 ",
      localTime: "10:00",
      minAgeDays: "90",
      unpaidOnly: true,
      includeReady: true,
      includeRacked: false,
      maxObjects: "10",
      maxRuns: "1",
      maxAmountCents: "100",
      reason: " 减少滞留 ",
    },
    new Date("2026-08-13T01:00:00.000Z"),
  );
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.draft.tool : null, "notification.delivery_batch.enqueue");
  assert.equal(result.ok ? result.draft.object_filter.min_age_days : null, 90);
  assert.equal(result.ok ? result.draft.object_filter.unpaid_only : null, true);
  assert.deepEqual(result.ok ? result.draft.object_filter.garment_statuses : null, ["ready"]);
  assert.equal(JSON.stringify(result).includes("url"), false);
  assert.equal(
    buildAutomationDraft(
      {
        name: "超期取件提醒",
        localTime: "23:00",
        minAgeDays: "30",
        unpaidOnly: false,
        includeReady: true,
        includeRacked: true,
        maxObjects: "10",
        maxRuns: "1",
        maxAmountCents: "100",
        reason: "减少滞留",
      },
      new Date("2026-08-13T01:00:00.000Z"),
    ).ok,
    false,
  );
});

test("policy loads pass AbortSignal and reject widened server rows", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const client: QueryPort = Object.freeze({
    execute: async <T = unknown>(
      _name: string,
      _body: unknown = {},
      options: Readonly<{ signal?: AbortSignal }> = {},
    ) => {
      void _body;
      receivedSignal = options?.signal;
      return Object.freeze({
        ok: true as const,
        data: Object.freeze({
          execution: "executed",
          result: Object.freeze({ policies: Object.freeze([]), store_id: "client-owned" }),
        }) as T,
      });
    },
  });
  const result = await loadAutomationPolicies(client, controller.signal);
  assert.equal(receivedSignal, controller.signal);
  assert.deepEqual(result, { ok: false, error: "自动化策略返回格式无效" });
});
