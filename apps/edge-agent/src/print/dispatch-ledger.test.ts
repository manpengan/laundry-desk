import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APP_CAPABILITY_ORIGIN } from "../lib/security-prefs.js";
import { signReceipt, type SignedExecutionReceipt } from "../pairing/sign-receipt.js";
import {
  type DispatchLedgerBinding,
  type DispatchLedgerEntry,
  PrintDispatchLedger,
} from "./dispatch-ledger.js";

const ROOT_PREFIX = join(tmpdir(), "laundry-print-ledger-");
const JOB = "936da01f-9abd-4d9d-80c7-02af85c822a8";
const OTHER_JOB = "11111111-1111-4111-8111-111111111111";
const THIRD_JOB = "22222222-2222-4222-8222-222222222222";
const DEVICE = "01a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const STAFF = "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c";
const NONCE = "9dfc4424-9b9a-4e52-baaa-c02868f8e7de";
const OTHER_NONCE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const THIRD_NONCE = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const SNAPSHOT_HASH = "a".repeat(64);
const CAPABILITY_HASH = "b".repeat(64);
const deviceKeys = generateKeyPairSync("ed25519");

function binding(overrides: Partial<DispatchLedgerBinding> = {}): DispatchLedgerBinding {
  return Object.freeze({
    jobId: JOB,
    deviceId: DEVICE,
    staffId: STAFF,
    origin: APP_CAPABILITY_ORIGIN,
    ticketNonce: NONCE,
    printerKind: "xp58",
    printAction: "enqueue",
    sourceJobId: null,
    snapshotSha256: SNAPSHOT_HASH,
    capabilitySha256: CAPABILITY_HASH,
    expectedReceiptSeq: 1,
    queue: "xp58-local",
    ...overrides,
  });
}

function signedReceipt(
  entry: DispatchLedgerEntry,
  sequence: number,
  result: "succeeded" | "failed" | "uncertain" = "succeeded",
): SignedExecutionReceipt {
  return signReceipt(
    Object.freeze({
      job_id: entry.binding.jobId,
      device_id: entry.binding.deviceId,
      ticket_nonce: entry.binding.ticketNonce,
      snapshot_sha256: entry.binding.snapshotSha256,
      result,
      cups_job_id: result === "succeeded" ? "xp58-local-42" : null,
      seq: sequence,
      at: "2026-08-01T01:02:03.000Z",
    }),
    deviceKeys.privateKey,
  );
}

test("ledger persists nonce before submission and exact signed receipt before upload", async (t) => {
  const root = await mkdtemp(ROOT_PREFIX);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const ledger = await PrintDispatchLedger.open(root);

  const prepared = await ledger.prepare(binding(), 1);
  assert.equal(prepared.created, true);
  assert.equal(prepared.entry.phase, "prepared");
  const preparedState = await readFile(join(root, "print-dispatch-ledger.json"), "utf8");
  assert.match(preparedState, /ticket_nonce/u);
  assert.match(preparedState, /"print_action":"enqueue"/u);
  assert.match(preparedState, /"source_job_id":null/u);
  const submitting = await ledger.markSubmitting(JOB, 2);
  const pending = await ledger.persistReceipt(JOB, (sequence) =>
    signedReceipt(submitting, sequence),
  );
  assert.equal(pending.receipt?.payload.seq, 1);
  assert.deepEqual((await ledger.pendingReceipts())[0]?.receipt, pending.receipt);

  const restarted = await PrintDispatchLedger.open(root);
  const retry = (await restarted.pendingReceipts())[0];
  assert.deepEqual(retry?.receipt, pending.receipt);
  assert.ok(retry?.receipt);
  const uploaded = await restarted.markUploaded(JOB, retry.receipt);
  assert.equal(uploaded.phase, "receipt_uploaded");
  assert.equal((await restarted.markUploaded(JOB, retry.receipt)).phase, "receipt_uploaded");
});

test("receipt sequence is durable across restart and upload collision fails closed", async (t) => {
  const root = await mkdtemp(ROOT_PREFIX);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const first = await PrintDispatchLedger.open(root);
  const firstPrepared = await first.prepare(binding());
  const firstPending = await first.persistReceipt(JOB, (sequence) =>
    signedReceipt(firstPrepared.entry, sequence, "failed"),
  );
  assert.equal(firstPending.receipt?.payload.seq, 1);

  const second = await PrintDispatchLedger.open(root);
  const otherBinding = binding({
    jobId: OTHER_JOB,
    ticketNonce: OTHER_NONCE,
    expectedReceiptSeq: 2,
  });
  const secondPrepared = await second.prepare(otherBinding);
  const secondPending = await second.persistReceipt(OTHER_JOB, (sequence) =>
    signedReceipt(secondPrepared.entry, sequence, "uncertain"),
  );
  assert.equal(secondPending.receipt?.payload.seq, 2);
  const firstReceipt = firstPending.receipt;
  assert.ok(firstReceipt);
  await assert.rejects(
    () =>
      second.markUploaded(JOB, {
        ...firstReceipt,
        sig: "A".repeat(86),
      }),
    /collision/u,
  );
});

test("duplicate nonce or changed binding is rejected without replacing the original", async (t) => {
  const root = await mkdtemp(ROOT_PREFIX);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const ledger = await PrintDispatchLedger.open(root);
  assert.equal((await ledger.prepare(binding())).created, true);
  assert.equal((await ledger.prepare(binding())).created, false);
  const reissued = await ledger.prepare(binding({ capabilitySha256: "d".repeat(64) }));
  assert.equal(reissued.created, false);
  assert.equal(reissued.entry.binding.capabilitySha256, "d".repeat(64));
  await assert.rejects(() => ledger.prepare(binding({ jobId: OTHER_JOB })), /collision/u);
  await assert.rejects(
    () => ledger.prepare(binding({ snapshotSha256: "c".repeat(64) })),
    /collision/u,
  );
  await assert.rejects(
    () => ledger.prepare(binding({ printAction: "retry", sourceJobId: OTHER_JOB })),
    /collision/u,
  );
});

test("legacy v1 records load as unknown lineage and cannot become formal evidence", async (t) => {
  const root = await mkdtemp(ROOT_PREFIX);
  const path = join(root, "print-dispatch-ledger.json");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const ledger = await PrintDispatchLedger.open(root);
  const prepared = await ledger.prepare(binding());
  await ledger.persistReceipt(JOB, (sequence) => signedReceipt(prepared.entry, sequence, "failed"));
  const persisted = JSON.parse(await readFile(path, "utf8")) as {
    records: readonly Record<string, unknown>[];
    [key: string]: unknown;
  };
  const current = persisted.records[0];
  assert.ok(current);
  const legacy = Object.fromEntries(
    Object.entries(current).filter(([key]) => key !== "print_action" && key !== "source_job_id"),
  );
  await writeFile(path, `${JSON.stringify({ ...persisted, records: [legacy] })}\n`, {
    mode: 0o600,
  });

  const restarted = await PrintDispatchLedger.open(root);
  const loaded = await restarted.get(JOB);
  assert.equal(loaded?.binding.printAction, "unknown");
  assert.equal(loaded?.binding.sourceJobId, null);
  const replay = await restarted.prepare(binding());
  assert.equal(replay.entry.binding.printAction, "unknown");
  assert.equal(replay.entry.binding.sourceJobId, null);
  await assert.rejects(
    () => restarted.prepare(binding({ printAction: "unknown" })),
    /lineage is not authoritative/u,
  );
});

test("valid-looking on-disk phase rollback is detected by the live high-water", async (t) => {
  const root = await mkdtemp(ROOT_PREFIX);
  const path = join(root, "print-dispatch-ledger.json");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const ledger = await PrintDispatchLedger.open(root);
  await ledger.prepare(binding());
  const oldState = await readFile(path, "utf8");
  await ledger.markSubmitting(JOB);

  await writeFile(path, oldState, { mode: 0o600 });
  await assert.rejects(() => ledger.get(JOB), /rollback/u);
});

test("signed receipt sequence mismatch is rejected before a dispatch can submit", async (t) => {
  const root = await mkdtemp(ROOT_PREFIX);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const ledger = await PrintDispatchLedger.open(root);

  await assert.rejects(
    () => ledger.prepare(binding({ sourceJobId: OTHER_JOB })),
    /lineage is not authoritative/u,
  );
  await assert.rejects(
    () => ledger.prepare(binding({ printAction: "retry" })),
    /lineage is not authoritative/u,
  );
  await assert.rejects(
    () => ledger.prepare(binding({ expectedReceiptSeq: 2 })),
    /sequence.*signed authority/u,
  );
  assert.equal(await ledger.get(JOB), null);
});

test("recovered authority may resync upward but never below the durable sequence", async (t) => {
  const root = await mkdtemp(ROOT_PREFIX);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const ledger = await PrintDispatchLedger.open(root);
  const recovered = await ledger.prepare(binding({ expectedReceiptSeq: 7 }), 1, true);
  assert.equal(recovered.requiresUncertain, true);
  const pending = await ledger.persistReceipt(JOB, (sequence) =>
    signedReceipt(recovered.entry, sequence, "uncertain"),
  );
  assert.equal(pending.receipt?.payload.seq, 7);

  await assert.rejects(
    () =>
      ledger.prepare(
        binding({ jobId: OTHER_JOB, ticketNonce: OTHER_NONCE, expectedReceiptSeq: 6 }),
        2,
        true,
      ),
    /sequence.*signed authority/u,
  );
});

test("symlink, hardlink, public mode and corrupt state are rejected", async (t) => {
  const root = await mkdtemp(ROOT_PREFIX);
  const path = join(root, "print-dispatch-ledger.json");
  const target = join(root, "target.json");
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(target, "{}\n", { mode: 0o600 });
  await symlink(target, path);
  await assert.rejects(() => PrintDispatchLedger.open(root), /symlink/u);

  await rm(path);
  await link(target, path);
  await assert.rejects(() => PrintDispatchLedger.open(root), /private durable JSON/u);
  await rm(path);
  await writeFile(path, "{not-json}\n", { mode: 0o600 });
  await assert.rejects(() => PrintDispatchLedger.open(root));
  await writeFile(path, '{"version":1,"next_receipt_seq":1,"records":[]}\n', { mode: 0o644 });
  await chmod(path, 0o644);
  await assert.rejects(() => PrintDispatchLedger.open(root), /private durable JSON/u);
});

test("private root is forced to 0700 and an O_EXCL staging collision is preserved", async (t) => {
  const root = await mkdtemp(ROOT_PREFIX);
  const stagingId = "1".repeat(24);
  const staging = join(root, `.print-dispatch-ledger.json.${stagingId}.staging`);
  t.after(async () => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o755);
  await writeFile(staging, "do-not-truncate\n", { mode: 0o600 });
  const ledger = await PrintDispatchLedger.open(root, { randomStagingId: () => stagingId });

  assert.equal((await stat(root)).mode & 0o777, 0o700);
  await assert.rejects(() => ledger.prepare(binding()), /EEXIST/u);
  assert.equal(await readFile(staging, "utf8"), "do-not-truncate\n");
  await assert.rejects(() => readFile(join(root, "print-dispatch-ledger.json")));
});

test("uploaded compaction keeps active rows, sequence high-water and replay protection", async (t) => {
  const root = await mkdtemp(ROOT_PREFIX);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const ledger = await PrintDispatchLedger.open(root, { retainedUploaded: 1 });
  const settle = async (input: DispatchLedgerBinding) => {
    const prepared = await ledger.prepare(input);
    const pending = await ledger.persistReceipt(input.jobId, (sequence) =>
      signedReceipt(prepared.entry, sequence, "failed"),
    );
    assert.ok(pending.receipt);
    await ledger.markUploaded(input.jobId, pending.receipt);
    return pending;
  };

  const firstBinding = binding();
  await settle(firstBinding);
  await settle(binding({ jobId: OTHER_JOB, ticketNonce: OTHER_NONCE, expectedReceiptSeq: 2 }));
  const activeBinding = binding({
    jobId: THIRD_JOB,
    ticketNonce: THIRD_NONCE,
    expectedReceiptSeq: 3,
  });
  await ledger.prepare(activeBinding);

  assert.equal(await ledger.get(JOB), null);
  assert.equal((await ledger.get(OTHER_JOB))?.phase, "receipt_uploaded");
  assert.equal((await ledger.get(THIRD_JOB))?.phase, "prepared");
  await assert.rejects(() => ledger.prepare(firstBinding), /Compacted.*replay/u);

  const restarted = await PrintDispatchLedger.open(root, { retainedUploaded: 1 });
  const active = await restarted.get(THIRD_JOB);
  assert.ok(active);
  const pending = await restarted.persistReceipt(THIRD_JOB, (sequence) =>
    signedReceipt(active, sequence, "failed"),
  );
  assert.equal(pending.receipt?.payload.seq, 3);
  await assert.rejects(() => restarted.prepare(firstBinding), /Compacted.*replay/u);
});
