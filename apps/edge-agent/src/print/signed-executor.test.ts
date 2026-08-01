import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  canonicalizeCapabilityTicketForSigning,
  canonicalizeForSignatureVerification,
  canonicalizePrintSnapshot,
  parseDeviceSignatureExecutionReceiptCandidate,
  type CapabilityTicketPayload,
  type PrintSnapshot,
} from "@laundry/contracts";

import { APP_CAPABILITY_ORIGIN } from "../lib/security-prefs.js";
import { base64UrlToBytes, bytesToBase64Url } from "../pairing/device-keys.js";
import { CupsSubmissionError } from "./cups-process.js";
import { type DispatchLedgerBinding, PrintDispatchLedger } from "./dispatch-ledger.js";
import { verifyPrintDispatch, type DispatchClaimTiming } from "./dispatch-verifier.js";
import { createSignedPrintExecutor, type SignedPrintExecutorOptions } from "./signed-executor.js";

const DEVICE_ID = "01a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const STAFF_ID = "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c";
const ORIGIN = APP_CAPABILITY_ORIGIN;
const JOB_ID = "936da01f-9abd-4d9d-80c7-02af85c822a8";
const OTHER_JOB_ID = "11111111-1111-4111-8111-111111111111";
const NONCE = "9dfc4424-9b9a-4e52-baaa-c02868f8e7de";
const OTHER_NONCE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const QUEUE = "xp58-local";
const ISSUED = "2026-08-01T01:02:03.000Z";
const EXP = "2026-08-01T01:03:03.000Z";
const RECEIPT_AT = "2026-08-01T01:02:04.000Z";
const TIMING: DispatchClaimTiming = Object.freeze({
  requestStartedWallMs: Date.parse(ISSUED),
  requestStartedMonoMs: 100,
  responseReceivedMonoMs: 110,
});
const server = generateKeyPairSync("ed25519");
const device = generateKeyPairSync("ed25519");

const SNAPSHOT: PrintSnapshot = Object.freeze({
  version: 1,
  store_name: "真实测试洗衣店",
  store_phone: "021-55550000",
  order_id: "61a2eed0-a6c3-493c-a3a7-20bf94b1d678",
  ticket_no: "T-20260801-1",
  received_at: ISSUED,
  customer_name: "张三",
  customer_phone: "13900000000",
  note: "深浅分洗",
  lines: Object.freeze([
    Object.freeze({
      line_index: 0,
      service_code: "wash",
      category_code: "shirt",
      unit_price_cents: 1_500,
      qty: 2,
      line_total_cents: 3_000,
      color: "蓝色",
      brand: null,
    }),
  ]),
  totals: Object.freeze({
    original_cents: 3_000,
    discount_cents: 0,
    addon_cents: 0,
    urgent_cents: 0,
    freight_cents: 0,
    payable_cents: 3_000,
    paid_cents: 2_000,
    balance_cents: 1_000,
  }),
  payment_methods: Object.freeze(["wechat"] as const),
});

function snapshotHash(snapshot: PrintSnapshot): string {
  return createHash("sha256").update(canonicalizePrintSnapshot(snapshot)).digest("hex");
}

function dispatch(
  jobId = JOB_ID,
  nonce = NONCE,
  snapshot: PrintSnapshot = SNAPSHOT,
  overrides: Partial<Extract<CapabilityTicketPayload, { action: "print_job" }>> = {},
): Readonly<{ capability_ticket: unknown; snapshot: PrintSnapshot }> {
  const payload: Extract<CapabilityTicketPayload, { action: "print_job" }> = Object.freeze({
    action: "print_job",
    job_id: jobId,
    staff_id: STAFF_ID,
    device_id: DEVICE_ID,
    origin: ORIGIN,
    issued_at: ISSUED,
    exp: EXP,
    nonce,
    printer_kind: "xp58",
    snapshot_sha256: snapshotHash(snapshot),
    recovered: false,
    next_receipt_seq: 1,
    ...overrides,
  });
  const authority = Object.freeze({ protocol_version: "1.0.0", payload });
  return Object.freeze({
    capability_ticket: Object.freeze({
      ...authority,
      sig: bytesToBase64Url(
        new Uint8Array(
          sign(null, canonicalizeCapabilityTicketForSigning(authority), server.privateKey),
        ),
      ),
    }),
    snapshot,
  });
}

function request(claim: unknown = dispatch()) {
  return Object.freeze({
    dispatch: claim,
    staffId: STAFF_ID,
    timing: TIMING,
    continuityTrusted: () => true,
  });
}

async function fixture(t: TestContext, overrides: Partial<SignedPrintExecutorOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "laundry-signed-print-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const ledger = await PrintDispatchLedger.open(root);
  let monotonicNow = 120;
  let submissions = 0;
  const options: SignedPrintExecutorOptions = Object.freeze({
    ledger,
    deviceId: DEVICE_ID,
    queue: QUEUE,
    devicePrivateKey: device.privateKey,
    serverPublicKey: () => server.publicKey,
    discoverQueues: async () => Object.freeze([QUEUE]),
    submitCups: async () => {
      submissions += 1;
      return `${QUEUE}-42`;
    },
    monotonicNowMs: () => monotonicNow,
    receiptNow: () => new Date(RECEIPT_AT),
    safetyMarginMs: 0,
    ...overrides,
  });
  return Object.freeze({
    root,
    ledger,
    options,
    executor: createSignedPrintExecutor(options),
    submissions: () => submissions,
    setMonotonicNow: (value: number) => {
      monotonicNow = value;
    },
  });
}

test("verified snapshot renders to CUPS and persists a device-signed accepted receipt", async (t) => {
  let submittedBytes = new Uint8Array();
  const setup = await fixture(t, {
    submitCups: async (_queue, bytes) => {
      submittedBytes = Uint8Array.from(bytes);
      return `${QUEUE}-42`;
    },
  });

  const result = await setup.executor.execute(request());

  assert.equal(result.state, "cups_accepted");
  assert.equal(result.cupsJobId, `${QUEUE}-42`);
  assert.ok(submittedBytes.byteLength > 0);
  assert.equal(result.receipt.payload.job_id, JOB_ID);
  assert.equal(result.receipt.payload.ticket_nonce, NONCE);
  assert.equal(result.receipt.payload.snapshot_sha256, snapshotHash(SNAPSHOT));
  const candidate = parseDeviceSignatureExecutionReceiptCandidate(result.receipt);
  assert.equal(
    verify(
      null,
      canonicalizeForSignatureVerification(candidate),
      device.publicKey,
      base64UrlToBytes(result.receipt.sig),
    ),
    true,
  );
  assert.deepEqual((await setup.ledger.pendingReceipts())[0]?.receipt, result.receipt);
});

test("tampered snapshot and exact staff/device/origin/printer mismatches fail before ledger/CUPS", async (t) => {
  const setup = await fixture(t);
  const tampered = Object.freeze({ ...SNAPSHOT, store_name: "被篡改洗衣店" });
  await assert.rejects(
    () => setup.executor.execute(request({ ...dispatch(), snapshot: tampered })),
    /wrong_snapshot/u,
  );
  for (const mismatch of [
    { staff_id: OTHER_JOB_ID },
    { device_id: OTHER_JOB_ID },
    { origin: "https://other.example.test" },
    { printer_kind: "dl206" as const },
  ]) {
    await assert.rejects(() =>
      setup.executor.execute(request(dispatch(JOB_ID, NONCE, SNAPSHOT, mismatch))),
    );
  }
  assert.equal(setup.submissions(), 0);
  assert.deepEqual(await setup.ledger.uncertainDispatches(), []);
});

test("durable duplicate nonce and exact dispatch replay never submit twice", async (t) => {
  const setup = await fixture(t);
  const first = await setup.executor.execute(request());
  const replayed = await setup.executor.execute(request());
  assert.deepEqual(replayed.receipt, first.receipt);
  assert.equal(setup.submissions(), 1);

  await assert.rejects(
    () => setup.executor.execute(request(dispatch(OTHER_JOB_ID, NONCE))),
    /collision/u,
  );
  assert.equal(setup.submissions(), 1);
});

test("timeout becomes durable uncertain and restart only retries the exact receipt", async (t) => {
  const setup = await fixture(t, {
    submitCups: async () => {
      throw new CupsSubmissionError("uncertain", "timeout");
    },
  });
  const uncertain = await setup.executor.execute(request());
  assert.equal(uncertain.state, "uncertain");
  assert.equal(uncertain.receipt.payload.cups_job_id, null);

  const restartedLedger = await PrintDispatchLedger.open(setup.root);
  let submissions = 0;
  const restarted = createSignedPrintExecutor({
    ...setup.options,
    ledger: restartedLedger,
    submitCups: async () => {
      submissions += 1;
      return `${QUEUE}-99`;
    },
  });
  const same = await restarted.execute(request());
  assert.deepEqual(same.receipt, uncertain.receipt);
  assert.equal(submissions, 0);
  assert.deepEqual((await restartedLedger.pendingReceipts())[0]?.receipt, uncertain.receipt);
});

test("restart turns both prepared and submitting entries into durable uncertain receipts", async (t) => {
  const setup = await fixture(t);
  const firstClaim = dispatch();
  const secondClaim = dispatch(OTHER_JOB_ID, OTHER_NONCE, SNAPSHOT, { next_receipt_seq: 2 });
  const verifiedFirst = verifyPrintDispatch(firstClaim, {
    serverPublicKey: server.publicKey,
    deviceId: DEVICE_ID,
    staffId: STAFF_ID,
    printerKind: "xp58",
    timing: TIMING,
    monotonicNowMs: () => 120,
    continuityTrusted: () => true,
    safetyMarginMs: 0,
  });
  const toBinding = (verified: typeof verifiedFirst): DispatchLedgerBinding =>
    Object.freeze({
      jobId: verified.payload.job_id,
      deviceId: DEVICE_ID,
      staffId: STAFF_ID,
      origin: ORIGIN,
      ticketNonce: verified.payload.nonce,
      printerKind: verified.payload.printer_kind,
      snapshotSha256: verified.payload.snapshot_sha256,
      capabilitySha256: verified.capabilitySha256,
      expectedReceiptSeq: verified.payload.next_receipt_seq,
      queue: QUEUE,
    });
  await setup.ledger.prepare(toBinding(verifiedFirst));

  let restartedLedger = await PrintDispatchLedger.open(setup.root);
  let submissions = 0;
  const restarted = createSignedPrintExecutor({
    ...setup.options,
    ledger: restartedLedger,
    submitCups: async () => {
      submissions += 1;
      return `${QUEUE}-99`;
    },
  });
  const recoveredPrepared = await restarted.recoverInterrupted();
  assert.deepEqual(
    recoveredPrepared.map((entry) => entry.receipt.payload.result),
    ["uncertain"],
  );
  assert.deepEqual(
    recoveredPrepared.map((entry) => entry.receipt.payload.seq),
    [1],
  );

  const verifiedSecond = verifyPrintDispatch(secondClaim, {
    serverPublicKey: server.publicKey,
    deviceId: DEVICE_ID,
    staffId: STAFF_ID,
    printerKind: "xp58",
    timing: TIMING,
    monotonicNowMs: () => 120,
    continuityTrusted: () => true,
    safetyMarginMs: 0,
  });
  await restartedLedger.prepare(toBinding(verifiedSecond));
  await restartedLedger.markSubmitting(OTHER_JOB_ID);
  restartedLedger = await PrintDispatchLedger.open(setup.root);
  const afterSubmitting = createSignedPrintExecutor({
    ...setup.options,
    ledger: restartedLedger,
    submitCups: async () => {
      submissions += 1;
      return `${QUEUE}-100`;
    },
  });
  const recoveredSubmitting = await afterSubmitting.recoverInterrupted();
  assert.deepEqual(
    recoveredSubmitting.map((entry) => entry.receipt.payload.seq),
    [2],
  );
  assert.equal(submissions, 0);
});

test("deleted ledger resyncs upward from recovered authority and returns exact uncertain", async (t) => {
  const setup = await fixture(t);
  const result = await setup.executor.execute(
    request(
      dispatch(JOB_ID, NONCE, SNAPSHOT, {
        recovered: true,
        next_receipt_seq: 7,
      }),
    ),
  );

  assert.equal(result.state, "uncertain");
  assert.equal(result.receipt.payload.seq, 7);
  assert.equal(setup.submissions(), 0);
  assert.deepEqual((await setup.ledger.pendingReceipts())[0]?.receipt, result.receipt);
});

test("signed next receipt sequence mismatch fails closed before CUPS", async (t) => {
  const setup = await fixture(t);
  await assert.rejects(
    () =>
      setup.executor.execute(
        request(
          dispatch(JOB_ID, NONCE, SNAPSHOT, {
            next_receipt_seq: 2,
          }),
        ),
      ),
    /sequence.*signed authority/u,
  );
  assert.equal(setup.submissions(), 0);
});

test(
  "exact concurrent dispatch replay is serialized and submits CUPS once",
  { timeout: 5_000 },
  async (t) => {
    const events: string[] = [];
    let releaseFirst = (): void => undefined;
    let signalFirstStarted = (): void => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    let submissions = 0;
    const setup = await fixture(t, {
      submitCups: async () => {
        submissions += 1;
        const current = submissions;
        events.push(`start:${current}`);
        if (current === 1) {
          signalFirstStarted();
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        events.push(`end:${current}`);
        return `${QUEUE}-${current}`;
      },
    });
    const first = setup.executor.execute(request(dispatch(JOB_ID, NONCE)));
    const second = setup.executor.execute(request(dispatch(JOB_ID, NONCE)));
    await Promise.race([
      firstStarted,
      delay(2_000).then(() => {
        throw new Error("first serialized CUPS submission did not start");
      }),
    ]);
    try {
      assert.deepEqual(events, ["start:1"]);
    } finally {
      releaseFirst();
    }
    const [accepted, replayed] = await Promise.all([first, second]);
    assert.equal(accepted.state, "cups_accepted");
    assert.deepEqual(replayed.receipt, accepted.receipt);
    assert.deepEqual(events, ["start:1", "end:1"]);
  },
);
