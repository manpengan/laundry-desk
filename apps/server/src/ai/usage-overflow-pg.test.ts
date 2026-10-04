import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { seedMigrationTenant } from "../data-transfer/import-test-fixture.js";
import { createPgAiConversationStore } from "./streaming-pg-store.js";
import { withAiContext } from "./streaming-pg-context.js";
import { createAiStreamingService } from "./streaming-service.js";
import { deterministicSyntheticTool, type AiProviderPort } from "./streaming-provider.js";
const urls = resolvePgUrls();
type Mode = "outside_contract" | "throw" | "abort";

async function fixture(admin: ReturnType<typeof createPgPool>) {
  const tenant = await seedMigrationTenant(admin);
  const authSessionId = randomUUID();
  const deviceId = randomUUID();
  await admin.query(
    "INSERT INTO sessions(id,org_id,store_id,staff_id,device_id,session_version,permission_version,authentication_method,status,created_at) VALUES($1,$2,$3,$4,$5,1,1,'password','active',now())",
    [authSessionId, tenant.orgId, tenant.storeId, tenant.staffId, deviceId],
  );
  await admin.query(
    "INSERT INTO ai_safety_policies(org_id,enabled,monthly_limit_micros,input_micros_per_million,output_micros_per_million,updated_at,updated_by,provider_code,model_id,config_version) VALUES($1,true,1000000,1000000,4000000,now() - interval '1 day',$2,'anthropic','fixture',1)",
    [tenant.orgId, tenant.staffId],
  );
  return { tenant, authSessionId, context: { tenant, authSessionId, deviceId } };
}

function runner(app: ReturnType<typeof createPgPool>, mode: Mode) {
  let calls = 0;
  let controller = new AbortController();
  const provider: AiProviderPort = {
    kind: "deterministic_fake",
    async *stream() {
      calls++;
      if (mode === "outside_contract") {
        yield { type: "end", finishReason: "stop", inputTokens: 30_000, outputTokens: 2000 };
        return;
      }
      yield { type: "delta", text: "A partially streamed result with no final usage." };
      if (mode === "abort") controller.abort();
      throw new Error("synthetic interrupted response");
    },
  };
  return {
    calls: () => calls,
    async run(context: Awaited<ReturnType<typeof fixture>>["context"]) {
      controller = new AbortController();
      // A fresh service per turn proves the decision lives in PostgreSQL, not in memory.
      const service = createAiStreamingService({
        store: createPgAiConversationStore(app),
        provider,
        tool: deterministicSyntheticTool,
      });
      const session = await service.createSession(context);
      const turn = await service.createTurn(
        session.session_id,
        { idempotency_key: randomUUID(), prompt: "fixture", max_output_tokens: 64 },
        context,
      );
      await service.runQueuedTurn(
        session.session_id,
        context,
        controller.signal,
        async () => undefined,
      );
      return turn.turn_id;
    },
  };
}

async function policy(admin: ReturnType<typeof createPgPool>, orgId: string) {
  return (
    await admin.query("SELECT enabled,config_version FROM ai_safety_policies WHERE org_id=$1", [
      orgId,
    ])
  ).rows[0] as { enabled: boolean; config_version: number };
}
async function audits(admin: ReturnType<typeof createPgPool>, orgId: string) {
  return (
    await admin.query(
      "SELECT command,after_json FROM audit_log WHERE org_id=$1 AND command LIKE 'ai.usage.%' ORDER BY at,id",
      [orgId],
    )
  ).rows.map((row: { command: string; after_json: string }) => ({
    command: row.command,
    ...(JSON.parse(row.after_json) as { reason: string; runtime_enabled: boolean }),
  }));
}

test(
  "PG usage outside the contract quarantines atomically and stays off across recreation",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const admin = createPgPool({ connectionString: urls.admin });
    const app = createPgPool({ connectionString: urls.app });
    try {
      const f = await fixture(admin);
      const r = runner(app, "outside_contract");
      const turnId = await r.run(f.context);
      assert.deepEqual(await policy(admin, f.tenant.orgId), { enabled: false, config_version: 2 });
      const usage = (
        await admin.query(
          "SELECT input_tokens,output_tokens,estimated_cost_micros FROM ai_usage WHERE org_id=$1",
          [f.tenant.orgId],
        )
      ).rows[0];
      assert.equal(usage.input_tokens, 20000);
      assert.equal(usage.output_tokens, 64);
      assert.equal(Number(usage.estimated_cost_micros), 20256);
      const terminal = (
        await admin.query("SELECT status,error_code FROM ai_turns WHERE id=$1", [turnId])
      ).rows[0];
      assert.deepEqual(terminal, { status: "failed", error_code: "AI_OUTPUT_LIMIT" });
      const [audit] = await audits(admin, f.tenant.orgId);
      assert.equal(audit?.command, "ai.usage.quarantine");
      assert.equal(audit?.reason, "outside_contract");
      await r.run(f.context);
      assert.equal(r.calls(), 1);
      // Re-running the quarantine for an audited turn after an administrator review is a no-op.
      await admin.query(
        "UPDATE ai_safety_policies SET enabled=true,config_version=3 WHERE org_id=$1",
        [f.tenant.orgId],
      );
      await withAiContext(app, f.context, async (client) =>
        client.query("SELECT public.ai_usage_quarantine($1,$2,$3,$4)", [
          turnId,
          f.authSessionId,
          randomUUID(),
          "outside_contract",
        ]),
      );
      assert.equal((await policy(admin, f.tenant.orgId)).enabled, true);
      await assert.rejects(app.query("UPDATE ai_safety_policies SET enabled=true"), {
        code: "42501",
      });
    } finally {
      await app.end();
      await admin.end();
    }
  },
);

test(
  "PG unknown usage is debited in full and disables the runtime only on the third in a day",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const admin = createPgPool({ connectionString: urls.admin });
    const app = createPgPool({ connectionString: urls.app });
    try {
      const f = await fixture(admin);
      const r = runner(app, "throw");
      for (const expected of [true, true]) {
        await r.run(f.context);
        assert.equal((await policy(admin, f.tenant.orgId)).enabled, expected);
      }
      await r.run(f.context);
      assert.deepEqual(await policy(admin, f.tenant.orgId), { enabled: false, config_version: 2 });
      assert.deepEqual(
        (await audits(admin, f.tenant.orgId)).map((row) => [row.command, row.runtime_enabled]),
        [
          ["ai.usage.unknown", true],
          ["ai.usage.unknown", true],
          ["ai.usage.quarantine", false],
        ],
      );
      const usage = (
        await admin.query(
          "SELECT count(*)::int AS turns, min(input_tokens) AS min_input FROM ai_usage WHERE org_id=$1",
          [f.tenant.orgId],
        )
      ).rows[0];
      assert.deepEqual(usage, { turns: 3, min_input: 20000 });
      await r.run(f.context);
      assert.equal(r.calls(), 3);
    } finally {
      await app.end();
      await admin.end();
    }
  },
);

test(
  "PG staff stop debits the reservation without counting towards quarantine",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const admin = createPgPool({ connectionString: urls.admin });
    const app = createPgPool({ connectionString: urls.app });
    try {
      const f = await fixture(admin);
      const r = runner(app, "abort");
      for (let index = 0; index < 3; index++) await r.run(f.context);
      assert.equal(r.calls(), 3);
      assert.deepEqual(await policy(admin, f.tenant.orgId), { enabled: true, config_version: 1 });
      assert.deepEqual(await audits(admin, f.tenant.orgId), []);
      const statuses = (
        await admin.query(
          "SELECT t.status, u.input_tokens FROM ai_turns t JOIN ai_usage u ON u.turn_id=t.id WHERE t.org_id=$1",
          [f.tenant.orgId],
        )
      ).rows;
      assert.equal(statuses.length, 3);
      for (const row of statuses)
        assert.deepEqual(row, { status: "cancelled", input_tokens: 20000 });
    } finally {
      await app.end();
      await admin.end();
    }
  },
);
