import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { DesktopSessionViewSchema, type PrintDispatchData } from "@laundry/contracts";

import type { EdgePrintHttpTransport } from "../desktop/print-http-transport.js";
import { RESOURCE_FAILURE } from "../desktop/http-transport-support.js";
import { APP_CAPABILITY_ORIGIN } from "../lib/security-prefs.js";
import { signReceipt, type SignedExecutionReceipt } from "../pairing/sign-receipt.js";
import { createPrintContinuity } from "./continuity.js";
import {
  createPrintDispatchController,
  type PrintDispatchControllerStatus,
} from "./dispatch-controller.js";
import { type DispatchLedgerBinding, PrintDispatchLedger } from "./dispatch-ledger.js";
import { createCupsRawPrintPort } from "./raw-print-port.js";
import { createSignedPrintExecutor } from "./signed-executor.js";

const JOB_ID = "936da01f-9abd-4d9d-80c7-02af85c822a8";
const DEVICE_ID = "01a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const STAFF_ID = "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c";
const NONCE = "9dfc4424-9b9a-4e52-baaa-c02868f8e7de";
const QUEUE = "xp58-local";
const SNAPSHOT_HASH = "a".repeat(64);
const keys = generateKeyPairSync("ed25519");
const server = generateKeyPairSync("ed25519");
const SESSION = DesktopSessionViewSchema.parse({
  session: {
    session_id: "00000000-0000-4000-8000-000000000001",
    session_version: 1,
    org_id: "00000000-0000-4000-8000-000000000002",
    store_id: "00000000-0000-4000-8000-000000000003",
    staff_id: STAFF_ID,
    device_id: DEVICE_ID,
    permission_version: 1,
  },
  role: "admin",
  features: {},
  display: { store_name: "Store", staff_name: "Admin", org_code: "org", store_code: "store" },
});
const TIMING = Object.freeze({
  requestStartedWallMs: 1_000,
  requestStartedMonoMs: 10,
  responseReceivedMonoMs: 20,
});

function binding(): DispatchLedgerBinding {
  return Object.freeze({
    jobId: JOB_ID,
    deviceId: DEVICE_ID,
    staffId: STAFF_ID,
    origin: APP_CAPABILITY_ORIGIN,
    ticketNonce: NONCE,
    printerKind: "xp58",
    printAction: "enqueue",
    sourceJobId: null,
    snapshotSha256: SNAPSHOT_HASH,
    capabilitySha256: "b".repeat(64),
    expectedReceiptSeq: 1,
    queue: QUEUE,
  });
}

async function pendingReceipt(ledger: PrintDispatchLedger): Promise<SignedExecutionReceipt> {
  await ledger.prepare(binding(), 1_000);
  await ledger.markSubmitting(JOB_ID, 1_001);
  const entry = await ledger.persistReceipt(JOB_ID, (sequence) =>
    signReceipt(
      Object.freeze({
        job_id: JOB_ID,
        device_id: DEVICE_ID,
        ticket_nonce: NONCE,
        snapshot_sha256: SNAPSHOT_HASH,
        result: "succeeded",
        cups_job_id: `${QUEUE}-42`,
        seq: sequence,
        at: "2026-08-01T01:02:03.000Z",
      }),
      keys.privateKey,
    ),
  );
  if (entry.receipt === null) throw new Error("receipt fixture failed");
  return entry.receipt;
}

function executor(
  ledger: PrintDispatchLedger,
  onSubmit = () => undefined,
  serverPublicKey: () => typeof server.publicKey | null = () => server.publicKey,
) {
  return createSignedPrintExecutor({
    ledger,
    deviceId: DEVICE_ID,
    queue: QUEUE,
    devicePrivateKey: keys.privateKey,
    serverPublicKey,
    printPort: createCupsRawPrintPort({
      discoverCups: async () => Object.freeze([QUEUE]),
      submitCups: async () => {
        onSubmit();
        return `${QUEUE}-99`;
      },
    }),
    monotonicNowMs: () => 30,
  });
}

async function ledgerRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "laundry-print-controller-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

test("restart uploads the byte-exact pending receipt before claiming and never resubmits CUPS", async (t) => {
  const root = await ledgerRoot(t);
  const firstLedger = await PrintDispatchLedger.open(root);
  const durableReceipt = await pendingReceipt(firstLedger);
  const restartedLedger = await PrintDispatchLedger.open(root);
  let submitted = 0;
  const uploads: SignedExecutionReceipt[] = [];
  let claims = 0;
  const transport: EdgePrintHttpTransport = Object.freeze({
    claim: async () => {
      claims += 1;
      return Object.freeze({ ok: true as const, data: null, session: SESSION, timing: TIMING });
    },
    receipt: async (receipt) => {
      uploads.push(receipt);
      return Object.freeze({
        ok: true as const,
        data: Object.freeze({
          job_id: JOB_ID,
          status: "done" as const,
          result: "succeeded" as const,
          cups_job_id: `${QUEUE}-42`,
          settled_at: "2026-08-01T01:02:04.000Z",
          duplicate: true,
        }),
      });
    },
  });
  const controller = createPrintDispatchController({
    transport,
    executor: executor(restartedLedger, () => {
      submitted += 1;
    }),
    ledger: restartedLedger,
    continuity: createPrintContinuity(),
    pollIntervalMs: 60_000,
    onError: () => undefined,
  });
  t.after(() => controller.stop());

  const result = await controller.start();

  assert.equal(result.state, "idle");
  assert.deepEqual(uploads[0], durableReceipt);
  assert.equal(submitted, 0);
  assert.equal(claims, 1);
  assert.deepEqual(await restartedLedger.pendingReceipts(), []);
});

test("startup seals an old prepared rollback as uncertain before any new claim", async (t) => {
  const root = await ledgerRoot(t);
  const original = await PrintDispatchLedger.open(root);
  await original.prepare(binding(), 1_000);
  const restartedLedger = await PrintDispatchLedger.open(root);
  const events: string[] = [];
  const uploads: SignedExecutionReceipt[] = [];
  let submitted = 0;
  const transport: EdgePrintHttpTransport = Object.freeze({
    claim: async () => {
      events.push("claim");
      return Object.freeze({ ok: true as const, data: null, session: SESSION, timing: TIMING });
    },
    receipt: async (receipt) => {
      events.push("receipt");
      uploads.push(receipt);
      return Object.freeze({
        ok: true as const,
        data: Object.freeze({
          job_id: JOB_ID,
          status: "uncertain" as const,
          result: "uncertain" as const,
          cups_job_id: null,
          settled_at: "2026-08-01T01:02:04.000Z",
          duplicate: false,
        }),
      });
    },
  });
  const controller = createPrintDispatchController({
    transport,
    executor: executor(restartedLedger, () => {
      submitted += 1;
    }),
    ledger: restartedLedger,
    continuity: createPrintContinuity(),
    pollIntervalMs: 60_000,
    onError: () => undefined,
  });
  t.after(() => controller.stop());

  assert.equal((await controller.start()).state, "idle");
  assert.deepEqual(events, ["receipt", "claim"]);
  assert.equal(submitted, 0);
  assert.equal(uploads[0]?.payload.result, "uncertain");
  assert.equal(uploads[0]?.payload.seq, 1);
});

test("mismatched server settlement fails closed and preserves the pending receipt", async (t) => {
  const root = await ledgerRoot(t);
  const ledger = await PrintDispatchLedger.open(root);
  const receipt = await pendingReceipt(ledger);
  let claims = 0;
  const transport: EdgePrintHttpTransport = Object.freeze({
    claim: async () => {
      claims += 1;
      return Object.freeze({ ok: true as const, data: null, session: SESSION, timing: TIMING });
    },
    receipt: async () =>
      Object.freeze({
        ok: true as const,
        data: Object.freeze({
          job_id: JOB_ID,
          status: "done" as const,
          result: "succeeded" as const,
          cups_job_id: `${QUEUE}-999`,
          settled_at: "2026-08-01T01:02:04.000Z",
          duplicate: false,
        }),
      }),
  });
  const controller = createPrintDispatchController({
    transport,
    executor: executor(ledger),
    ledger,
    continuity: createPrintContinuity(),
    pollIntervalMs: 60_000,
    onError: () => undefined,
  });
  t.after(() => controller.stop());

  assert.equal((await controller.start()).state, "failed");
  assert.equal(claims, 0);
  assert.deepEqual((await ledger.pendingReceipts())[0]?.receipt, receipt);
});

test("executor rejection is reported while the returned status stays generic", async (t) => {
  const root = await ledgerRoot(t);
  const ledger = await PrintDispatchLedger.open(root);
  const errors: unknown[] = [];
  const transport: EdgePrintHttpTransport = Object.freeze({
    claim: async () =>
      Object.freeze({
        ok: true as const,
        data: Object.freeze({}) as PrintDispatchData,
        session: SESSION,
        timing: TIMING,
      }),
    receipt: async () => RESOURCE_FAILURE,
  });
  const controller = createPrintDispatchController({
    transport,
    executor: executor(
      ledger,
      () => undefined,
      () => null,
    ),
    ledger,
    continuity: createPrintContinuity(),
    pollIntervalMs: 60_000,
    onError: (error) => errors.push(error),
  });
  t.after(() => controller.stop());

  const result = await controller.start();

  assert.equal(result.state, "failed");
  assert.equal(result.message, "Signed print dispatch was rejected");
  assert.equal(errors.length, 1);
  assert.equal(errors[0] instanceof Error, true);
  assert.equal((errors[0] as Error).message, "Pinned print authority key is unavailable");
});

test("interval failures are observable and later polls continue", async (t) => {
  const root = await ledgerRoot(t);
  const ledger = await PrintDispatchLedger.open(root);
  let claims = 0;
  let errors = 0;
  const statuses: PrintDispatchControllerStatus[] = [];
  const transport: EdgePrintHttpTransport = Object.freeze({
    claim: async () => {
      claims += 1;
      if (claims === 2) throw new Error("controlled poll failure");
      return Object.freeze({ ok: true as const, data: null, session: SESSION, timing: TIMING });
    },
    receipt: async () => RESOURCE_FAILURE,
  });
  const controller = createPrintDispatchController({
    transport,
    executor: executor(ledger),
    ledger,
    continuity: createPrintContinuity(),
    pollIntervalMs: 250,
    onStatus: (next) => statuses.push(next),
    onError: () => {
      errors += 1;
    },
  });
  t.after(() => controller.stop());

  assert.equal((await controller.start()).state, "idle");
  await delay(650);
  await controller.stop();

  assert.equal(errors, 1);
  assert.ok(claims >= 3);
  assert.ok(statuses.some((entry) => entry.state === "failed"));
  assert.equal(statuses.at(-1)?.state, "idle");
});
