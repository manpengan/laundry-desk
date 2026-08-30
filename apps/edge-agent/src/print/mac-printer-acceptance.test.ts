import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, renameSync } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createMacPrinterAcceptanceRecord,
  loadMacPrinterAcceptanceEvidence,
  writeMacPrinterAcceptanceRecord,
  type MacPrinterAcceptanceEvidence,
  type SignedPrintAcceptanceEvidence,
} from "./mac-printer-acceptance.js";
import { APP_CAPABILITY_ORIGIN } from "../lib/security-prefs.js";
import { signReceipt } from "../pairing/sign-receipt.js";
import { PrintDispatchLedger } from "./dispatch-ledger.js";

const original: SignedPrintAcceptanceEvidence = Object.freeze({
  job_id: "936da01f-9abd-4d9d-80c7-02af85c822a8",
  snapshot_sha256: "a".repeat(64),
  queue: "Store_XP58",
  printer_kind: "xp58",
  print_action: "enqueue",
  source_job_id: null,
  cups_job_id: "Store_XP58-42",
  receipt_seq: 7,
  result: "succeeded",
});
const disconnectAttempt: SignedPrintAcceptanceEvidence = Object.freeze({
  ...original,
  job_id: "cb3b00b5-e6fc-45da-a565-895819118e92",
  cups_job_id: null,
  print_action: "reprint",
  source_job_id: original.job_id,
  receipt_seq: 8,
  result: "failed",
});
const explicitReprint: SignedPrintAcceptanceEvidence = Object.freeze({
  ...original,
  job_id: "a7ef3809-f73d-44ad-aeda-326faa476921",
  cups_job_id: "Store_XP58-44",
  print_action: "retry",
  source_job_id: disconnectAttempt.job_id,
  receipt_seq: 9,
});
const evidence: MacPrinterAcceptanceEvidence = Object.freeze({
  original,
  disconnect_attempt: disconnectAttempt,
  explicit_reprint: explicitReprint,
});
const confirmed = Object.freeze({
  chinese_clear: true,
  amounts_correct: true,
  feed_ok: true,
  cut_or_tear_ok: true,
  barcode_scanned: true,
  disconnect_no_duplicate: true,
  explicit_reprint_one_copy: true,
});
const recordOptions = Object.freeze({
  printerModel: "Xprinter XP-58IIH",
  connection: "usb" as const,
  packagedApp: Object.freeze({
    bundle_identifier: "com.laundry-desk.v2" as const,
    bundle_name: "laundry-desk V2" as const,
    bundle_executable: "laundry-desk V2" as const,
    app_version: "0.1.0",
    app_asar_sha256: "b".repeat(64),
    spa_manifest_sha256: "c".repeat(64),
    info_plist_sha256: "d".repeat(64),
  }),
  acceptedAt: "2026-07-30T08:00:00.000Z",
});

test("schema v3 fingerprints the three-job physical flow and packaged app", () => {
  const record = createMacPrinterAcceptanceRecord(evidence, confirmed, recordOptions);
  assert.equal(record.schema_version, 3);
  assert.equal(record.printer_model, "Xprinter XP-58IIH");
  assert.equal(record.connection, "usb");
  assert.equal(record.app_version, recordOptions.packagedApp.app_version);
  assert.deepEqual(record.packaged_app, recordOptions.packagedApp);
  assert.deepEqual(
    [
      record.print_flow.original.result,
      record.print_flow.disconnect_attempt.result,
      record.print_flow.explicit_reprint.result,
    ],
    ["succeeded", "failed", "succeeded"],
  );
  assert.equal(record.print_flow.disconnect_attempt.cups_job_fingerprint, null);
  assert.deepEqual(
    [
      record.print_flow.original.print_action,
      record.print_flow.disconnect_attempt.print_action,
      record.print_flow.explicit_reprint.print_action,
    ],
    ["enqueue", "reprint", "retry"],
  );
  const serialized = JSON.stringify(record);
  for (const secret of [
    original.job_id,
    disconnectAttempt.job_id,
    explicitReprint.job_id,
    original.queue,
    original.cups_job_id!,
    explicitReprint.cups_job_id!,
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.throws(
    () =>
      createMacPrinterAcceptanceRecord(
        evidence,
        { ...confirmed, barcode_scanned: false },
        recordOptions,
      ),
    /all physical sample checks/u,
  );
  const runtimeInvalidConfirmations: readonly unknown[] = [
    {},
    { ...confirmed, barcode_scanned: undefined },
    { ...confirmed, unexpected: true },
    { ...confirmed, barcode_scanned: "YES" },
  ];
  for (const invalid of runtimeInvalidConfirmations) {
    assert.throws(
      () => createMacPrinterAcceptanceRecord(evidence, invalid as typeof confirmed, recordOptions),
      /all physical sample checks/u,
    );
  }
});

test("schema v3 rejects any weak or mismatched three-job proof", () => {
  const cases: readonly MacPrinterAcceptanceEvidence[] = [
    { ...evidence, disconnect_attempt: { ...disconnectAttempt, job_id: original.job_id } },
    {
      ...evidence,
      disconnect_attempt: { ...disconnectAttempt, snapshot_sha256: "d".repeat(64) },
    },
    { ...evidence, disconnect_attempt: { ...disconnectAttempt, queue: "Other_XP58" } },
    { ...evidence, disconnect_attempt: { ...disconnectAttempt, result: "succeeded" } },
    { ...evidence, disconnect_attempt: { ...disconnectAttempt, cups_job_id: "Store_XP58-43" } },
    { ...evidence, disconnect_attempt: { ...disconnectAttempt, receipt_seq: 7 } },
    {
      ...evidence,
      explicit_reprint: { ...explicitReprint, cups_job_id: original.cups_job_id },
    },
    {
      ...evidence,
      disconnect_attempt: {
        ...disconnectAttempt,
        printer_kind: "dl206",
      } as unknown as SignedPrintAcceptanceEvidence,
    },
    {
      ...evidence,
      original: {
        ...original,
        print_action: "unknown",
      } as unknown as SignedPrintAcceptanceEvidence,
    },
    {
      ...evidence,
      disconnect_attempt: { ...disconnectAttempt, source_job_id: explicitReprint.job_id },
    },
    {
      ...evidence,
      explicit_reprint: { ...explicitReprint, print_action: "reprint" },
    },
  ];
  for (const invalid of cases) {
    assert.throws(() => createMacPrinterAcceptanceRecord(invalid, confirmed, recordOptions));
  }
  assert.throws(
    () =>
      createMacPrinterAcceptanceRecord(evidence, confirmed, {
        ...recordOptions,
        printerModel: "XP58\nsecret",
      }),
    /printer model/u,
  );
  assert.throws(
    () =>
      createMacPrinterAcceptanceRecord(evidence, confirmed, {
        ...recordOptions,
        packagedApp: { ...recordOptions.packagedApp, app_asar_sha256: "user-supplied" },
      }),
    /packaged app evidence/u,
  );
});

test(
  "acceptance record is create-only in a private canonical directory",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "laundry-printer-acceptance-"));
    t.after(async () => {
      await rm(root, { recursive: true });
    });
    const directory = join(await realpath(root), "records");
    const record = createMacPrinterAcceptanceRecord(evidence, confirmed, recordOptions);
    const path = await writeMacPrinterAcceptanceRecord(directory, record);
    const metadata = await lstat(path);
    assert.equal(metadata.mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), record);
    await assert.rejects(
      () => writeMacPrinterAcceptanceRecord("relative", record),
      /canonical and absolute/u,
    );
  },
);

test(
  "concurrent acceptance writes remain bound to their own private directories",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "laundry-printer-concurrent-write-"));
    t.after(async () => rm(root, { recursive: true }));
    const canonicalRoot = await realpath(root);
    const firstDirectory = join(canonicalRoot, "first");
    const secondDirectory = join(canonicalRoot, "second");
    const record = createMacPrinterAcceptanceRecord(evidence, confirmed, recordOptions);
    const [first, second] = await Promise.all([
      writeMacPrinterAcceptanceRecord(firstDirectory, record),
      writeMacPrinterAcceptanceRecord(secondDirectory, record),
    ]);
    assert.equal(first.startsWith(`${firstDirectory}/`), true);
    assert.equal(second.startsWith(`${secondDirectory}/`), true);
    for (const path of [first, second]) {
      assert.equal((await lstat(path)).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), record);
    }
  },
);

test(
  "acceptance record never writes into a replaced output directory",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "laundry-printer-directory-race-"));
    t.after(async () => rm(root, { recursive: true }));
    const canonicalRoot = await realpath(root);
    const directory = join(canonicalRoot, "records");
    const displaced = join(canonicalRoot, "records-displaced");
    const record = createMacPrinterAcceptanceRecord(evidence, confirmed, recordOptions);
    await assert.rejects(
      () =>
        writeMacPrinterAcceptanceRecord(directory, record, {
          afterCwdBound: () => {
            renameSync(directory, displaced);
            mkdirSync(directory, { mode: 0o700 });
          },
        }),
      /acceptance directory changed before writing/u,
    );
    assert.deepEqual(await readdir(directory), []);
    assert.deepEqual(await readdir(displaced), []);
  },
);

test(
  "acceptance record removes an inode-bound file when the path changes before create",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "laundry-printer-create-race-"));
    t.after(async () => rm(root, { recursive: true }));
    const canonicalRoot = await realpath(root);
    const directory = join(canonicalRoot, "records");
    const displaced = join(canonicalRoot, "records-displaced");
    const record = createMacPrinterAcceptanceRecord(evidence, confirmed, recordOptions);
    await assert.rejects(
      () =>
        writeMacPrinterAcceptanceRecord(directory, record, {
          afterPathCheck: () => {
            renameSync(directory, displaced);
            mkdirSync(directory, { mode: 0o700 });
          },
        }),
      /acceptance record changed while writing/u,
    );
    assert.deepEqual(await readdir(directory), []);
    assert.deepEqual(await readdir(displaced), []);
  },
);

type FixtureOutcome = Readonly<{
  evidence: SignedPrintAcceptanceEvidence;
  nonce: string;
}>;

async function persistFixtureReceipt(
  ledger: PrintDispatchLedger,
  fixture: FixtureOutcome,
  sequence: number,
  upload: boolean,
): Promise<ReturnType<PrintDispatchLedger["get"]>> {
  await ledger.prepare({
    jobId: fixture.evidence.job_id,
    deviceId: "01a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    staffId: "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c",
    origin: APP_CAPABILITY_ORIGIN,
    ticketNonce: fixture.nonce,
    printerKind: "xp58",
    printAction: sequence === 1 ? "enqueue" : sequence === 2 ? "reprint" : "retry",
    sourceJobId:
      sequence === 1 ? null : sequence === 2 ? original.job_id : disconnectAttempt.job_id,
    snapshotSha256: fixture.evidence.snapshot_sha256,
    capabilitySha256: "f".repeat(64),
    expectedReceiptSeq: sequence,
    queue: fixture.evidence.queue,
  });
  await ledger.markSubmitting(fixture.evidence.job_id);
  const keys = generateKeyPairSync("ed25519");
  const pending = await ledger.persistReceipt(fixture.evidence.job_id, (receiptSequence) =>
    signReceipt(
      {
        job_id: fixture.evidence.job_id,
        device_id: "01a2eed0-a6c3-493c-a3a7-20bf94b1d678",
        ticket_nonce: fixture.nonce,
        snapshot_sha256: fixture.evidence.snapshot_sha256,
        result: fixture.evidence.result,
        cups_job_id: fixture.evidence.cups_job_id,
        seq: receiptSequence,
        at: `2026-07-30T07:59:5${sequence}.000Z`,
      },
      keys.privateKey,
    ),
  );
  if (pending.receipt === null) throw new Error("receipt fixture failed");
  if (upload) await ledger.markUploaded(fixture.evidence.job_id, pending.receipt);
  return ledger.get(fixture.evidence.job_id);
}

test("formal evidence requires all three exact uploaded device receipts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-printer-evidence-"));
  t.after(async () => rm(root, { recursive: true }));
  const ledger = await PrintDispatchLedger.open(root);
  const fixtureEvidence: MacPrinterAcceptanceEvidence = Object.freeze({
    original: { ...original, receipt_seq: 1 },
    disconnect_attempt: { ...disconnectAttempt, receipt_seq: 2, result: "uncertain" },
    explicit_reprint: { ...explicitReprint, receipt_seq: 3 },
  });
  const fixtures = [
    { evidence: fixtureEvidence.original, nonce: "9dfc4424-9b9a-4e52-baaa-c02868f8e7de" },
    {
      evidence: fixtureEvidence.disconnect_attempt,
      nonce: "aa22c2a0-81b5-48bd-966c-414c58c32f37",
    },
    {
      evidence: fixtureEvidence.explicit_reprint,
      nonce: "36e046d1-da47-48c0-a367-a568819b9b03",
    },
  ] as const;
  await persistFixtureReceipt(ledger, fixtures[0], 1, true);
  const disconnectPending = await persistFixtureReceipt(ledger, fixtures[1], 2, false);
  await persistFixtureReceipt(ledger, fixtures[2], 3, true);
  await assert.rejects(
    () =>
      loadMacPrinterAcceptanceEvidence(root, {
        original: fixtureEvidence.original.job_id,
        disconnect: fixtureEvidence.disconnect_attempt.job_id,
        reprint: fixtureEvidence.explicit_reprint.job_id,
      }),
    /three uploaded/u,
  );
  if (disconnectPending === null || disconnectPending.receipt === null) {
    throw new Error("disconnect receipt fixture failed");
  }
  await ledger.markUploaded(fixtureEvidence.disconnect_attempt.job_id, disconnectPending.receipt);
  assert.deepEqual(
    await loadMacPrinterAcceptanceEvidence(root, {
      original: fixtureEvidence.original.job_id,
      disconnect: fixtureEvidence.disconnect_attempt.job_id,
      reprint: fixtureEvidence.explicit_reprint.job_id,
    }),
    fixtureEvidence,
  );
});

test("invalid job input fails without reflecting caller data", async () => {
  const supplied = "secret-invalid-job-id";
  await assert.rejects(
    () =>
      loadMacPrinterAcceptanceEvidence("/not-used", {
        original: supplied,
        disconnect: disconnectAttempt.job_id,
        reprint: explicitReprint.job_id,
      }),
    (error: unknown) => error instanceof Error && !error.message.includes(supplied),
  );
});
