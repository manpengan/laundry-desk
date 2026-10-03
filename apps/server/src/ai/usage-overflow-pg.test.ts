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
for (const mode of ["outside_contract", "throw", "abort"] as const)
  test(
    `PG metering quarantines ${mode} atomically and stays off across store recreation`,
    { skip: urls === null },
    async () => {
      assert.ok(urls);
      const admin = createPgPool({ connectionString: urls.admin });
      const app = createPgPool({ connectionString: urls.app });
      try {
        const tenant = await seedMigrationTenant(admin);
        const authSessionId = randomUUID();
        const deviceId = randomUUID();
        const context = { tenant, authSessionId, deviceId };
        await admin.query(
          "INSERT INTO sessions(id,org_id,store_id,staff_id,device_id,session_version,permission_version,authentication_method,status,created_at) VALUES($1,$2,$3,$4,$5,1,1,'password','active',now())",
          [authSessionId, tenant.orgId, tenant.storeId, tenant.staffId, deviceId],
        );
        await admin.query(
          "INSERT INTO ai_safety_policies(org_id,enabled,monthly_limit_micros,input_micros_per_million,output_micros_per_million,updated_at,updated_by,provider_code,model_id,config_version) VALUES($1,true,1000000,1000000,4000000,now(),$2,'anthropic','fixture',1)",
          [tenant.orgId, tenant.staffId],
        );
        let calls = 0;
        const controller = new AbortController();
        const provider: AiProviderPort = {
          kind: "deterministic_fake",
          async *stream() {
            calls++;
            if (mode !== "outside_contract") {
              yield { type: "delta", text: "A partially streamed result with no final usage." };
              if (mode === "abort") controller.abort();
              throw new Error("synthetic interrupted response");
            }
            yield { type: "end", finishReason: "stop", inputTokens: 30_000, outputTokens: 2000 };
          },
        };
        const make = () =>
          createAiStreamingService({
            store: createPgAiConversationStore(app),
            provider,
            tool: deterministicSyntheticTool,
          });
        const service = make();
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
        const policy = (
          await admin.query(
            "SELECT enabled,config_version FROM ai_safety_policies WHERE org_id=$1",
            [tenant.orgId],
          )
        ).rows[0];
        assert.equal(policy.enabled, false);
        assert.equal(policy.config_version, 2);
        const usage = (
          await admin.query(
            "SELECT input_tokens,output_tokens,estimated_cost_micros FROM ai_usage WHERE org_id=$1",
            [tenant.orgId],
          )
        ).rows[0];
        assert.equal(usage.input_tokens, 20000);
        assert.equal(usage.output_tokens, 64);
        assert.equal(Number(usage.estimated_cost_micros), 20256);
        const terminal = (
          await admin.query("SELECT status,error_code FROM ai_turns WHERE id=$1", [turn.turn_id])
        ).rows[0];
        assert.equal(terminal.status, mode === "abort" ? "cancelled" : "failed");
        assert.equal(
          terminal.error_code,
          mode === "abort"
            ? "AI_ABORTED"
            : mode === "throw"
              ? "AI_PROVIDER_FAILED"
              : "AI_OUTPUT_LIMIT",
        );
        const audit = (
          await admin.query(
            "SELECT after_json FROM audit_log WHERE org_id=$1 AND command='ai.usage.quarantine'",
            [tenant.orgId],
          )
        ).rows[0];
        assert.equal(
          JSON.parse(audit.after_json).reason,
          mode === "outside_contract" ? mode : "usage_unknown",
        );
        assert.equal(
          (
            await admin.query(
              "SELECT id FROM audit_log WHERE org_id=$1 AND command='ai.usage.quarantine'",
              [tenant.orgId],
            )
          ).rows.length,
          1,
        );
        const restarted = make();
        const next = await restarted.createSession(context);
        await restarted.createTurn(
          next.session_id,
          { idempotency_key: randomUUID(), prompt: "fixture", max_output_tokens: 64 },
          context,
        );
        await restarted.runQueuedTurn(
          next.session_id,
          context,
          new AbortController().signal,
          async () => undefined,
        );
        assert.equal(calls, 1);
        await admin.query(
          "UPDATE ai_safety_policies SET enabled=true,config_version=3 WHERE org_id=$1",
          [tenant.orgId],
        );
        await withAiContext(app, context, async (client) =>
          client.query("SELECT public.ai_usage_quarantine($1,$2,$3,$4)", [
            turn.turn_id,
            authSessionId,
            randomUUID(),
            mode === "outside_contract" ? mode : "usage_unknown",
          ]),
        );
        assert.equal(
          (
            await admin.query(
              "SELECT enabled,config_version FROM ai_safety_policies WHERE org_id=$1",
              [tenant.orgId],
            )
          ).rows[0].enabled,
          true,
        );
        await assert.rejects(app.query("UPDATE ai_safety_policies SET enabled=true"), {
          code: "42501",
        });
      } finally {
        await app.end();
        await admin.end();
      }
    },
  );
