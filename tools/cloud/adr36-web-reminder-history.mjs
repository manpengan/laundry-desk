import { createHash } from "node:crypto";

import {
  asRecord,
  requireInteger,
  requireString,
  requireThat,
  requireUuid,
} from "./adr36-web-core.mjs";
import { stableJson } from "./adr36-web-journey-support.mjs";
import { requireReminderFixtureProof } from "./adr36-web-reminder-fixture.mjs";

const TIERS = Object.freeze([30, 90, 180]);
const EXPECTED_COUNTS = Object.freeze([3, 2, 1]);
const MESSAGE_TEMPLATE = "订单{{tickets}}共{{garment_count}}件，欠款{{balance_cents}}分";
const CSV_HEADER = Object.freeze([
  "customer_name",
  "customer_phone",
  "ticket_nos",
  "garment_count",
  "balance_cents",
  "message",
]);

function parseQuotedCsvLine(line) {
  const cells = [];
  let cursor = 0;
  while (cursor < line.length) {
    requireThat(line[cursor] === '"', "REMINDER_CSV_INVALID");
    cursor += 1;
    let cell = "";
    let closed = false;
    while (cursor < line.length) {
      if (line[cursor] !== '"') {
        cell += line[cursor];
        cursor += 1;
      } else if (line[cursor + 1] === '"') {
        cell += '"';
        cursor += 2;
      } else {
        cursor += 1;
        closed = true;
        break;
      }
    }
    requireThat(closed && (cursor === line.length || line[cursor] === ","), "REMINDER_CSV_INVALID");
    cells.push(cell);
    if (cursor < line.length) cursor += 1;
  }
  return Object.freeze(cells);
}

function parseReminderCsv(csv) {
  requireThat(
    typeof csv === "string" &&
      csv.startsWith("\uFEFF") &&
      csv.endsWith("\r\n") &&
      !/(^|[^\r])\n|\r(?!\n)/u.test(csv),
    "REMINDER_CSV_LINE_ENDING_INVALID",
  );
  return Object.freeze(csv.slice(1, -2).split("\r\n").map(parseQuotedCsvLine));
}

function fixtureCandidates(value, fixture, tier) {
  const result = asRecord(value, "REMINDER_CANDIDATES_INVALID");
  requireThat(
    typeof result.generated_at === "string" &&
      Number.isFinite(Date.parse(result.generated_at)) &&
      result.channels?.manual === true &&
      result.channels?.sms === false &&
      result.channels?.wechat === false &&
      Array.isArray(result.candidates),
    "REMINDER_CANDIDATES_INVALID",
  );
  const fixtureIds = new Set(fixture.rows.map((row) => row.orderId));
  const selected = result.candidates
    .filter((entry) => fixtureIds.has(asRecord(entry, "REMINDER_CANDIDATES_INVALID").order_id))
    .map((entry) => asRecord(entry, "REMINDER_CANDIDATES_INVALID"))
    .sort((left, right) => left.order_id.localeCompare(right.order_id));
  const expected = fixture.rows
    .filter((row) => row.ageDays >= tier)
    .sort((left, right) => left.orderId.localeCompare(right.orderId));
  requireThat(selected.length === expected.length, "REMINDER_TIER_MEMBERSHIP_INVALID");
  for (const [index, candidate] of selected.entries()) {
    const row = expected[index];
    requireThat(
      candidate.order_id === row.orderId &&
        candidate.ticket_no === row.ticketNo &&
        candidate.customer_id === row.customerId &&
        candidate.customer_name === row.customerName &&
        candidate.customer_phone === row.phone &&
        candidate.garment_count === 1 &&
        candidate.balance_cents === 1_000 &&
        candidate.received_at === row.createdAt &&
        Number.isSafeInteger(candidate.overdue_days) &&
        candidate.overdue_days >= row.ageDays &&
        Array.isArray(candidate.garment_statuses) &&
        candidate.garment_statuses.length === 1 &&
        candidate.garment_statuses[0] === "ready" &&
        candidate.last_contact_at === null,
      "REMINDER_CANDIDATE_PROOF_INVALID",
    );
  }
  return Object.freeze(selected);
}

function expectedMessage(candidate) {
  return `订单${candidate.ticket_no}共1件，欠款1000分`;
}

function verifyCsvRows(csv, rows) {
  const parsed = parseReminderCsv(csv);
  requireThat(parsed.length === rows.length + 1, "REMINDER_CSV_ROWS_INVALID");
  requireThat(
    parsed[0].length === CSV_HEADER.length &&
      parsed[0].every((cell, index) => cell === CSV_HEADER[index]),
    "REMINDER_CSV_HEADER_INVALID",
  );
  for (const [index, raw] of parsed.slice(1).entries()) {
    const row = rows[index];
    const expected = [
      row.customer_name ?? "",
      row.customer_phone,
      row.ticket_nos.join(" "),
      String(row.garment_count),
      String(row.balance_cents),
      row.message,
    ];
    requireThat(
      raw.length === expected.length &&
        raw.every((cell, cellIndex) => cell === expected[cellIndex]),
      "REMINDER_CSV_CONTENT_INVALID",
    );
  }
}

function verifyManualList(value, candidates) {
  const result = asRecord(value, "REMINDER_LIST_INVALID");
  const batchId = requireUuid(result.batch_id, "REMINDER_LIST_INVALID");
  const csv = requireString(result.csv, "REMINDER_LIST_INVALID");
  const sha256 = createHash("sha256").update(Buffer.from(csv, "utf8")).digest("hex");
  requireThat(
    result.channel === "manual" &&
      result.status === "list_generated" &&
      result.cost_cents === 0 &&
      result.order_count === candidates.length &&
      result.recipient_count === candidates.length &&
      result.content_sha256 === sha256 &&
      typeof result.generated_at === "string" &&
      Number.isFinite(Date.parse(result.generated_at)) &&
      typeof result.filename === "string" &&
      /^pickup-reminders-\d{8}-[0-9a-f]{8}\.csv$/u.test(result.filename) &&
      Array.isArray(result.rows) &&
      result.rows.length === candidates.length,
    "REMINDER_LIST_INVALID",
  );
  const byOrder = new Map(candidates.map((candidate) => [candidate.order_id, candidate]));
  const rows = result.rows.map((entry) => {
    const row = asRecord(entry, "REMINDER_LIST_INVALID");
    requireThat(
      Array.isArray(row.order_ids) && row.order_ids.length === 1,
      "REMINDER_LIST_INVALID",
    );
    const orderId = requireUuid(row.order_ids[0], "REMINDER_LIST_INVALID");
    const candidate = byOrder.get(orderId);
    requireThat(
      candidate !== undefined &&
        Array.isArray(row.ticket_nos) &&
        row.ticket_nos.length === 1 &&
        row.ticket_nos[0] === candidate.ticket_no &&
        row.customer_name === candidate.customer_name &&
        row.customer_phone === candidate.customer_phone &&
        requireInteger(row.garment_count, "REMINDER_LIST_INVALID") === 1 &&
        requireInteger(row.balance_cents, "REMINDER_LIST_INVALID") === 1_000 &&
        row.message === expectedMessage(candidate),
      "REMINDER_LIST_INVALID",
    );
    byOrder.delete(orderId);
    return row;
  });
  requireThat(byOrder.size === 0, "REMINDER_LIST_INVALID");
  verifyCsvRows(csv, rows);
  return Object.freeze({ batchId, sha256, stable: stableJson(result) });
}

/**
 * The branded proof can only be minted after the loopback owner transaction
 * installed the three synthetic history rows. No query or CSV command runs
 * before that proof is accepted.
 */
export async function reminderHistoryJourney(api, context, proof) {
  requireThat(typeof api?.query === "function", "REMINDER_API_INVALID");
  requireThat(typeof api?.confirmReplayable === "function", "REMINDER_API_INVALID");
  const runId = requireString(context?.runId, "REMINDER_CONTEXT_INVALID");
  const session = asRecord(context?.session, "REMINDER_CONTEXT_INVALID");
  const fixture = requireReminderFixtureProof(proof, runId);
  requireThat(
    session.orgId === fixture.orgId && session.storeId === fixture.storeId,
    "REMINDER_CONTEXT_INVALID",
  );

  const tiers = [];
  for (const ageDays of TIERS) {
    const value = await api.query(session, "notification.pickup_reminders.list", {
      min_age_days: ageDays,
      unpaid_only: true,
      garment_statuses: ["ready"],
      limit: 200,
    });
    tiers.push(Object.freeze({ ageDays, candidates: fixtureCandidates(value, fixture, ageDays) }));
  }

  const batches = [];
  for (const [index, tier] of tiers.entries()) {
    requireThat(tier.candidates.length === EXPECTED_COUNTS[index], "REMINDER_TIER_COUNT_INVALID");
    const execution = asRecord(
      await api.confirmReplayable(session, "notification.manual_list.create", {
        order_ids: tier.candidates.map((candidate) => candidate.order_id),
        group_by: "order",
        message_template: MESSAGE_TEMPLATE,
        format: "csv",
        min_age_days: tier.ageDays,
        unpaid_only: true,
        garment_statuses: ["ready"],
      }),
      "REMINDER_LIST_INVALID",
    );
    requireThat(typeof execution.replay === "function", "REMINDER_LIST_REPLAY_INVALID");
    const verified = verifyManualList(execution.result, tier.candidates);
    const replayed = verifyManualList(await execution.replay(), tier.candidates);
    requireThat(replayed.stable === verified.stable, "REMINDER_LIST_REPLAY_INVALID");
    batches.push(
      Object.freeze({
        ageDays: tier.ageDays,
        batchId: verified.batchId,
        sha256: verified.sha256,
        orderCount: tier.candidates.length,
        recipientCount: tier.candidates.length,
      }),
    );
  }
  return Object.freeze({ batches: Object.freeze(batches) });
}
