import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { runAcceptance } from "./adr36-web-acceptance.mjs";
import {
  TEST_EXTENSIONS,
  acceptanceEnvironment,
  createFakeCloud,
  sequentialUuid,
} from "./adr36-web-acceptance.test-support.mjs";
import { buildReminderFixtureArtifacts } from "./adr36-web-reminder-fixture-data.mjs";
import {
  REMINDER_FIXTURE_OPT_IN,
  createReminderHistoryFixture,
  reminderFixtureRequested,
  requireReminderFixtureProof,
  runReminderFixtureSql,
} from "./adr36-web-reminder-fixture.mjs";
import { reminderHistoryJourney } from "./adr36-web-reminder-history.mjs";

const NOW = new Date("2026-08-10T12:34:56.000Z");
const RUN = Object.freeze({ runId: "ADR36-20260810T123456Z-abcdef12" });
const SESSION = Object.freeze({
  orgId: "11111111-1111-4111-8111-111111111103",
  storeId: "11111111-1111-4111-8111-111111111104",
  staffId: "11111111-1111-4111-8111-111111111101",
  deviceId: "11111111-1111-4111-8111-111111111107",
});
const BATCH_IDS = Object.freeze([
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
]);

function fixtureEnvironment(overrides = {}) {
  return Object.freeze({
    PATH: "/usr/bin:/bin",
    LAUNDRY_ADR36_REMINDER_FIXTURE: REMINDER_FIXTURE_OPT_IN,
    DATABASE_ADMIN_URL: "postgresql://postgres:database-secret@127.0.0.1:5432/laundry_v2",
    ...overrides,
  });
}

function sqlRunner(calls) {
  return async (sql) => {
    calls.push(sql);
    if (sql.includes("ADR36_REMINDER_FIXTURE_APPLIED")) {
      return `ADR36_REMINDER_FIXTURE_APPLIED|${RUN.runId}|3`;
    }
    if (sql.includes("ADR36_REMINDER_FIXTURE_VERIFIED")) {
      return `ADR36_REMINDER_FIXTURE_VERIFIED|${RUN.runId}|3`;
    }
    if (sql.includes("ADR36_REMINDER_FIXTURE_CLEANED")) {
      return `ADR36_REMINDER_FIXTURE_CLEANED|${RUN.runId}|3`;
    }
    assert.fail("unexpected fixture SQL");
  };
}

function validEvidence() {
  return Object.freeze({
    batches: Object.freeze(
      [30, 90, 180].map((ageDays, index) =>
        Object.freeze({
          ageDays,
          batchId: BATCH_IDS[index],
          sha256: String(index + 1).repeat(64),
          orderCount: 3 - index,
          recipientCount: 3 - index,
        }),
      ),
    ),
  });
}

async function fixture(calls = []) {
  return createReminderHistoryFixture({
    env: fixtureEnvironment(),
    cwd: "/opt/laundry-desk",
    now: NOW,
    run: RUN,
    session: SESSION,
    inspectTarget: async () => ({ root: "/opt/laundry-desk", gitSha: "a".repeat(40) }),
    executeSql: sqlRunner(calls),
  });
}

test("reminder fixture requires one exact explicit opt-in", () => {
  assert.equal(reminderFixtureRequested({}), false);
  assert.equal(
    reminderFixtureRequested({ LAUNDRY_ADR36_REMINDER_FIXTURE: REMINDER_FIXTURE_OPT_IN }),
    true,
  );
  assert.throws(() => reminderFixtureRequested({ LAUNDRY_ADR36_REMINDER_FIXTURE: "yes" }), {
    code: "REMINDER_FIXTURE_OPT_IN_INVALID",
  });
});

test("fixture rejects non-loopback or non-cloud-test targets before SQL", async () => {
  await assert.rejects(
    createReminderHistoryFixture({
      env: fixtureEnvironment({
        DATABASE_ADMIN_URL: "postgresql://postgres:secret@db.example.test:5432/laundry_v2",
      }),
      cwd: "/opt/laundry-desk",
      now: NOW,
      run: RUN,
      session: SESSION,
      inspectTarget: async () => ({ root: "/opt/laundry-desk", gitSha: "a".repeat(40) }),
    }),
    { code: "REMINDER_FIXTURE_DATABASE_INVALID" },
  );
  await assert.rejects(
    createReminderHistoryFixture({
      env: fixtureEnvironment(),
      cwd: "/tmp/not-cloud",
      now: NOW,
      run: RUN,
      session: SESSION,
      inspectTarget: async () => {
        throw new Error("wrong marker");
      },
    }),
    { code: "REMINDER_FIXTURE_TARGET_INVALID" },
  );
});

test("fixture apply, database verification and cleanup are transactional and cleanup is repeatable", async () => {
  const calls = [];
  const controller = await fixture(calls);
  const proof = await controller.prepare();
  const artifacts = requireReminderFixtureProof(proof, RUN.runId);
  assert.deepEqual(
    artifacts.rows.map((row) => row.ageDays),
    [31, 91, 181],
  );
  assert.ok(artifacts.rows.every((row) => /^199\d{8}$/u.test(row.phone)));
  await controller.verify(validEvidence());
  assert.equal(await controller.cleanup(), true);
  assert.equal(await controller.cleanup(), true);
  assert.throws(() => requireReminderFixtureProof(proof, RUN.runId), {
    code: "REMINDER_FIXTURE_PROOF_REQUIRED",
  });
  assert.equal(calls.length, 4);
  assert.ok(calls.every((sql) => sql.startsWith("BEGIN;\nSET LOCAL ROLE laundry_owner;")));
  assert.match(calls[0], /host\(inet_server_addr\(\)\) NOT IN \('127\.0\.0\.1', '::1'\)/u);
  assert.doesNotMatch(calls[0], /inet_server_addr\(\)::text/u);
  assert.match(calls[0], /INSERT INTO customers/u);
  assert.match(calls[0], /INSERT INTO audit_log/u);
  assert.match(calls[1], /notification_log/u);
  assert.match(calls[1], /notification\.manual_list\.create/u);
  assert.match(calls[1], /FROM expected_batches AS expected/u);
  assert.match(calls[1], /audit\.after_json::jsonb ->> 'content_sha256'/u);
  assert.match(calls[2], /DELETE FROM notification_log/u);
  assert.match(calls[2], /ON CONFLICT \(id\) DO NOTHING/u);
  assert.match(calls[2], /fixture cleanup audit mismatch/u);
  assert.doesNotMatch(calls.join("\n"), /database-secret/u);
});

test("psql runner keeps the database URL and password out of argv and output", async () => {
  let invocation;
  const spawnImpl = (file, args, options) => {
    invocation = { file, args, options };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        callback();
        queueMicrotask(() => {
          child.stdout.end("SAFE_MARKER\n");
          child.emit("close", 0, null);
        });
      },
    });
    return child;
  };
  const output = await runReminderFixtureSql(
    "SELECT 'SAFE_MARKER';",
    "postgresql://postgres:database-secret@127.0.0.1:5432/laundry_v2",
    { env: { PATH: "/usr/bin:/bin" }, spawnImpl },
  );
  assert.equal(output, "SAFE_MARKER");
  assert.equal(invocation.file, "/usr/bin/psql");
  assert.doesNotMatch(JSON.stringify(invocation.args), /database-secret|postgresql:/u);
  assert.equal(invocation.options.env.PGPASSWORD, "database-secret");
  assert.equal(Object.hasOwn(invocation.options.env, "DATABASE_ADMIN_URL"), false);
});

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function manualResult(candidates, ageDays) {
  const rows = candidates.map((candidate) => ({
    order_ids: [candidate.order_id],
    ticket_nos: [candidate.ticket_no],
    customer_name: candidate.customer_name,
    customer_phone: candidate.customer_phone,
    garment_count: 1,
    balance_cents: 1_000,
    message: `订单${candidate.ticket_no}共1件，欠款1000分`,
  }));
  const lines = [
    ["customer_name", "customer_phone", "ticket_nos", "garment_count", "balance_cents", "message"],
    ...rows.map((row) => [
      row.customer_name,
      row.customer_phone,
      row.ticket_nos.join(" "),
      row.garment_count,
      row.balance_cents,
      row.message,
    ]),
  ];
  const csv = `\uFEFF${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`;
  const batchId = BATCH_IDS[[30, 90, 180].indexOf(ageDays)];
  return Object.freeze({
    batch_id: batchId,
    generated_at: NOW.toISOString(),
    channel: "manual",
    status: "list_generated",
    cost_cents: 0,
    recipient_count: rows.length,
    order_count: rows.length,
    filename: `pickup-reminders-20260810-${batchId.slice(0, 8)}.csv`,
    content_sha256: createHash("sha256").update(Buffer.from(csv, "utf8")).digest("hex"),
    csv,
    rows,
  });
}

function reminderApi(artifacts, options = {}) {
  const calls = [];
  return Object.freeze({
    calls,
    query: async (_session, name, args) => {
      calls.push({ kind: "query", name, args });
      const candidates = artifacts.rows
        .filter((row) => row.ageDays >= args.min_age_days)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((row) => ({
          order_id: row.orderId,
          ticket_no: row.ticketNo,
          customer_id: row.customerId,
          customer_name: row.customerName,
          customer_phone: row.phone,
          garment_count: 1,
          balance_cents: 1_000,
          received_at: row.createdAt,
          overdue_days: row.ageDays,
          garment_statuses: ["ready"],
          last_contact_at: null,
        }));
      return {
        generated_at: NOW.toISOString(),
        channels: { manual: true, sms: false, wechat: false },
        candidates,
      };
    },
    confirmReplayable: async (_session, name, args) => {
      calls.push({ kind: "command", name, args });
      const candidates = artifacts.rows
        .filter((row) => args.order_ids.includes(row.orderId))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((row) => ({
          order_id: row.orderId,
          ticket_no: row.ticketNo,
          customer_name: row.customerName,
          customer_phone: row.phone,
        }));
      const result = manualResult(candidates, args.min_age_days);
      const returned =
        options.badHash === args.min_age_days
          ? { ...result, content_sha256: "0".repeat(64) }
          : result;
      return Object.freeze({ result: returned, replay: async () => returned });
    },
  });
}

test("history journey proves 30/90/180 tiers before audited list and raw CSV validation", async () => {
  const calls = [];
  const controller = await fixture(calls);
  const proof = await controller.prepare();
  const artifacts = buildReminderFixtureArtifacts({ runId: RUN.runId, now: NOW, session: SESSION });
  const api = reminderApi(artifacts);
  const evidence = await reminderHistoryJourney(api, { session: SESSION, runId: RUN.runId }, proof);
  assert.deepEqual(
    evidence.batches.map((batch) => [batch.ageDays, batch.orderCount]),
    [
      [30, 3],
      [90, 2],
      [180, 1],
    ],
  );
  assert.deepEqual(
    api.calls.slice(0, 3).map((call) => call.kind),
    ["query", "query", "query"],
  );
  assert.deepEqual(
    api.calls.slice(0, 3).map((call) => call.args.min_age_days),
    [30, 90, 180],
  );
  assert.equal(api.calls.filter((call) => call.kind === "command").length, 3);
  assert.doesNotMatch(JSON.stringify(evidence), /199\d{8}|customer_phone|csv/u);
  await controller.verify(evidence);
  assert.equal(await controller.cleanup(), true);
});

test("history journey rejects missing proof before any reminder API call", async () => {
  const artifacts = buildReminderFixtureArtifacts({ runId: RUN.runId, now: NOW, session: SESSION });
  const api = reminderApi(artifacts);
  await assert.rejects(
    reminderHistoryJourney(api, { session: SESSION, runId: RUN.runId }, Object.freeze({})),
    { code: "REMINDER_FIXTURE_PROOF_REQUIRED" },
  );
  assert.equal(api.calls.length, 0);
});

test("history journey fails closed on a manual-list CSV digest mismatch", async () => {
  const controller = await fixture();
  const proof = await controller.prepare();
  const artifacts = buildReminderFixtureArtifacts({ runId: RUN.runId, now: NOW, session: SESSION });
  await assert.rejects(
    reminderHistoryJourney(
      reminderApi(artifacts, { badHash: 90 }),
      { session: SESSION, runId: RUN.runId },
      proof,
    ),
    { code: "REMINDER_LIST_INVALID" },
  );
  assert.equal(await controller.cleanup(), true);
});

test("acceptance becomes PASS only when opted-in fixture prepare, proof journey, verify and cleanup all pass", async () => {
  const env = Object.freeze({
    ...acceptanceEnvironment(),
    LAUNDRY_ADR36_REMINDER_FIXTURE: REMINDER_FIXTURE_OPT_IN,
  });
  const cloud = createFakeCloud(env);
  const lifecycle = [];
  const report = await runAcceptance({
    ...TEST_EXTENSIONS,
    env,
    fetchImpl: cloud.fetchImpl,
    randomUUID: sequentialUuid(),
    now: () => NOW,
    writeLine: () => {},
    createReminderFixture: async () => ({
      prepare: async () => {
        lifecycle.push("prepare");
        return Object.freeze({ testProof: true });
      },
      verify: async () => lifecycle.push("verify"),
      cleanup: async () => {
        lifecycle.push("cleanup");
        return true;
      },
    }),
    reminderHistoryJourney: async (_api, context, proof) => {
      lifecycle.push("journey");
      assert.equal(context.runId.startsWith("ADR36-"), true);
      assert.equal(proof.testProof, true);
      return validEvidence();
    },
  });
  assert.equal(report.exitCode, 0);
  assert.deepEqual(lifecycle, ["prepare", "journey", "verify", "cleanup"]);
  assert.deepEqual(
    report.results.find((entry) => entry.journey === "reminder_history"),
    { journey: "reminder_history", status: "PASS" },
  );
  assert.deepEqual(report.results.at(-1), { journey: "overall", status: "PASS" });
});

test("acceptance fails closed when a proven reminder fixture cannot be cleaned", async () => {
  const env = Object.freeze({
    ...acceptanceEnvironment(),
    LAUNDRY_ADR36_REMINDER_FIXTURE: REMINDER_FIXTURE_OPT_IN,
  });
  const report = await runAcceptance({
    ...TEST_EXTENSIONS,
    env,
    fetchImpl: createFakeCloud(env).fetchImpl,
    randomUUID: sequentialUuid(),
    now: () => NOW,
    writeLine: () => {},
    createReminderFixture: async () => ({
      prepare: async () => Object.freeze({ testProof: true }),
      verify: async () => {},
      cleanup: async () => false,
    }),
    reminderHistoryJourney: async () => validEvidence(),
  });
  assert.equal(report.exitCode, 1);
  assert.deepEqual(
    report.results.find((entry) => entry.journey === "safe_cleanup"),
    {
      journey: "safe_cleanup",
      status: "FAIL",
      code: "CLEANUP_INCOMPLETE",
    },
  );
  assert.deepEqual(report.results.at(-1), {
    journey: "overall",
    status: "FAIL",
    code: "ACCEPTANCE_FAILED",
  });
});
