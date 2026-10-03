import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { createPgAiConversationStore } from "./streaming-pg-store.js";

const urls = resolvePgUrls(process.env);
test(
  "real PG admits bounded assistant card events and audits new tools with tenant/session isolation",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const admin = createPgPool({ connectionString: urls.admin });
    const app = createPgPool({ connectionString: urls.app });
    const context = {
      tenant: { orgId: randomUUID(), storeId: randomUUID(), staffId: randomUUID() },
      authSessionId: randomUUID(),
      deviceId: randomUUID(),
    };
    const { orgId, storeId, staffId } = context.tenant;
    const now = new Date();
    const store = createPgAiConversationStore(app);
    try {
      await admin.query(
        "INSERT INTO orgs(id,code,name,created_at,updated_at) VALUES($1,$2,'AI fixture',now(),now())",
        [orgId, `ai-${orgId}`],
      );
      await admin.query(
        "INSERT INTO stores(id,org_id,code,name,created_at,updated_at) VALUES($1,$2,'main','AI fixture',now(),now())",
        [storeId, orgId],
      );
      await admin.query(
        "INSERT INTO staffs(id,org_id,username,password_hash,display_name,is_active,permission_version,created_at,updated_at) VALUES($1,$2,$3,'synthetic','Fixture',true,1,now(),now())",
        [staffId, orgId, `ai-${staffId}`],
      );
      await admin.query(
        "INSERT INTO staff_store_roles(id,org_id,store_id,staff_id,role,is_active,created_at,updated_at) VALUES($1,$2,$3,$4,'admin',true,now(),now())",
        [randomUUID(), orgId, storeId, staffId],
      );
      await admin.query(
        "INSERT INTO sessions(id,org_id,store_id,staff_id,device_id,session_version,permission_version,authentication_method,status,created_at) VALUES($1,$2,$3,$4,$5,1,1,'password','active',now())",
        [context.authSessionId, orgId, storeId, staffId, context.deviceId],
      );
      const session = await store.createSession({
        id: randomUUID(),
        auditId: randomUUID(),
        context,
        now,
      });
      const created = await store.createTurn({
        id: randomUUID(),
        messageId: randomUUID(),
        auditId: randomUUID(),
        sessionId: session.session_id,
        idempotencyKey: randomUUID(),
        prompt: "synthetic preview",
        promptSha256: "a".repeat(64),
        maxOutputTokens: 64,
        inputRedactions: 0,
        context,
        now,
      });
      // This test isolates SQL event/attempt admission; budget execution is covered by the runner suite.
      await admin.query("UPDATE ai_turns SET status='running',started_at=now() WHERE id=$1", [
        created.turn.id,
      ]);
      const preview = {
        command: "garment.rework" as const,
        confirm_ref: randomUUID(),
        summary: "核对条码后返洗",
        expires_at: new Date(Date.now() + 300000).toISOString(),
      };
      await store.appendEvent({
        id: randomUUID(),
        turnId: created.turn.id,
        context,
        now,
        event: {
          type: "tool_result",
          tool: "operations.preview",
          step: 1,
          outcome: "succeeded",
          preview,
        },
      });
      for (const [index, toolName] of (
        ["operations.preview", "pickup.candidates", "business.trend"] as const
      ).entries()) {
        await store.appendToolAttempt({
          context,
          attempt: {
            id: randomUUID(),
            turnId: created.turn.id,
            step: index + 1,
            toolName,
            requestSha256: "b".repeat(64),
            resultSha256: "c".repeat(64),
            outcome: "succeeded",
            durationMs: 1,
            resultCount: 1,
            sourceCount: 1,
            filterCount: 1,
            auditId: randomUUID(),
            createdAt: now,
          },
        });
      }
      const events = await store.listEvents(session.session_id, 0, 10, context);
      assert.deepEqual(events[0]?.type === "tool_result" ? events[0].preview : null, preview);
      await assert.rejects(
        store.appendEvent({
          id: randomUUID(),
          turnId: created.turn.id,
          context: { ...context, authSessionId: randomUUID() },
          now,
          event: { type: "tool_call", tool: "pickup.candidates", step: 2 },
        }),
      );
      assert.deepEqual(
        await store.listEvents(session.session_id, 0, 10, {
          ...context,
          tenant: { ...context.tenant, storeId: randomUUID() },
        }),
        [],
      );
      const audit = await admin.query<{ value: string }>(
        "SELECT after_json AS value FROM audit_log WHERE org_id=$1 AND command='ai.assistant_tool.execute'",
        [orgId],
      );
      assert.equal(audit.rows.length, 3);
      assert.equal(JSON.stringify(audit.rows).includes(preview.confirm_ref), false);
      await assert.rejects(app.query("UPDATE ai_tool_attempts SET outcome='failed'"), {
        code: "42501",
      });
    } finally {
      for (const table of [
        "audit_log",
        "ai_tool_attempts",
        "ai_stream_events",
        "ai_messages",
        "ai_turns",
        "ai_sessions",
        "sessions",
        "staff_store_roles",
        "staffs",
        "stores",
        "customer_privacy_hmac_keys",
      ])
        await admin.query(`DELETE FROM public.${table} WHERE org_id=$1`, [orgId]);
      await admin.query("DELETE FROM orgs WHERE id=$1", [orgId]);
      await Promise.all([app.end(), admin.end()]);
    }
  },
);
