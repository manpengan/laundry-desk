import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import test from "node:test";

import {
  PrintSnapshotSchema,
  canonicalizeCapabilityTicketForSigning,
  canonicalizeExecutionReceiptForSigning,
  type PrintDispatchData,
  type PrintExecutionReceiptRequest,
  type PrintSnapshot,
} from "@laundry/contracts";

import { createPgPool, resolvePgUrls, type PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { PrintDispatchError, type PrintDispatchSession } from "./dispatch-service.js";
import { createPgPrintDispatchService } from "./pg-print-dispatch.js";
import { createPgPrintJobStore } from "./pg-print-store.js";
import { hashPrintSnapshot } from "./snapshot.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;

type Fixture = Readonly<{
  adminPool: PgPool;
  appPool: PgPool;
  session: PrintDispatchSession;
  devicePrivateKey: KeyObject;
  devicePublicKey: KeyObject;
  serverKeys: ReturnType<typeof generateKeyPairSync>;
  jobIds: string[];
  orderIds: string[];
  close(): Promise<void>;
}>;

async function createFixture(): Promise<Fixture> {
  assert.ok(urls);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app, max: 8 });
  const deviceKeys = generateKeyPairSync("ed25519");
  const serverKeys = generateKeyPairSync("ed25519");
  const deviceId = randomUUID();
  const spki = deviceKeys.publicKey.export({ type: "spki", format: "der" });
  const fingerprint = createHash("sha256").update(spki).digest("hex");
  const jobIds: string[] = [];
  const orderIds: string[] = [];
  await seedPgTestIdentityFixture(adminPool);
  await adminPool.query(
    `INSERT INTO edge_devices (
       org_id, store_id, device_id, public_key_spki, public_key_fingerprint,
       status, paired_by_staff_id, paired_at, last_seen_at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'paired', $6::uuid,
               clock_timestamp(), clock_timestamp())`,
    [DEMO_ORG_ID, DEMO_STORE_ID, deviceId, spki.toString("base64url"), fingerprint, DEMO_ADMIN_ID],
  );
  const session = Object.freeze({
    orgId: DEMO_ORG_ID,
    storeId: DEMO_STORE_ID,
    staffId: DEMO_ADMIN_ID,
    deviceId,
  });
  return Object.freeze({
    adminPool,
    appPool,
    session,
    devicePrivateKey: deviceKeys.privateKey,
    devicePublicKey: deviceKeys.publicKey,
    serverKeys,
    jobIds,
    orderIds,
    close: async () => {
      try {
        await adminPool.query("DELETE FROM audit_log WHERE device_id = $1::uuid", [deviceId]);
        await adminPool.query(
          `DELETE FROM print_device_receipt_heads
            WHERE org_id = $1::uuid AND store_id = $2::uuid AND device_id = $3::uuid`,
          [DEMO_ORG_ID, DEMO_STORE_ID, deviceId],
        );
        if (jobIds.length > 0) {
          await adminPool.query("DELETE FROM print_jobs WHERE id = ANY($1::uuid[])", [jobIds]);
        }
        if (orderIds.length > 0) {
          await adminPool.query("DELETE FROM payments WHERE order_id = ANY($1::uuid[])", [
            orderIds,
          ]);
          await adminPool.query("DELETE FROM order_lines WHERE order_id = ANY($1::uuid[])", [
            orderIds,
          ]);
          await adminPool.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [orderIds]);
        }
        await adminPool.query(
          `DELETE FROM edge_devices
            WHERE org_id = $1::uuid AND store_id = $2::uuid AND device_id = $3::uuid`,
          [DEMO_ORG_ID, DEMO_STORE_ID, deviceId],
        );
      } finally {
        await Promise.all([appPool.end(), adminPool.end()]);
      }
    },
  });
}

function snapshot(orderId: string, ticketNo: string): PrintSnapshot {
  return Object.freeze({
    version: 1,
    store_name: "PG Print Test",
    store_phone: null,
    order_id: orderId,
    ticket_no: ticketNo,
    received_at: "2026-08-01T00:00:00.000Z",
    customer_name: null,
    customer_phone: null,
    note: null,
    lines: Object.freeze([
      Object.freeze({
        line_index: 0,
        service_code: "wash",
        category_code: "shirt",
        unit_price_cents: 500,
        qty: 1,
        line_total_cents: 500,
        color: null,
        brand: null,
      }),
    ]),
    totals: Object.freeze({
      original_cents: 500,
      discount_cents: 0,
      addon_cents: 0,
      urgent_cents: 0,
      freight_cents: 0,
      payable_cents: 500,
      paid_cents: 500,
      balance_cents: 0,
    }),
    payment_methods: Object.freeze(["cash" as const]),
  });
}

async function seedSignedJob(fixture: Fixture, createdAt: Date, kind: "xp58" | "dl206" = "xp58") {
  const jobId = randomUUID();
  const orderId = randomUUID();
  const ticketNo = `T-${jobId.slice(0, 8)}`;
  const printSnapshot = snapshot(orderId, ticketNo);
  fixture.jobIds.push(jobId);
  await withStoreGucOrCurrent(fixture.appPool, fixture.session, (client) =>
    client.query(
      `INSERT INTO print_jobs (
         id, org_id, store_id, order_id, ticket_no, kind, status,
         snapshot_json, snapshot_sha256, created_at, updated_at
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'queued',
                 $7::jsonb, $8, $9, $9)`,
      [
        jobId,
        fixture.session.orgId,
        fixture.session.storeId,
        orderId,
        ticketNo,
        kind,
        JSON.stringify(printSnapshot),
        hashPrintSnapshot(printSnapshot),
        createdAt,
      ],
    ),
  );
  return Object.freeze({ jobId, snapshot: printSnapshot, hash: hashPrintSnapshot(printSnapshot) });
}

async function seedOrderBackedJob(fixture: Fixture, createdAtEpoch: number) {
  const orderId = randomUUID();
  const ticketNo = `REAL-${orderId.slice(0, 8)}`;
  fixture.orderIds.push(orderId);
  await fixture.adminPool.query(
    `INSERT INTO orders (
       id, org_id, store_id, ticket_no, status, customer_phone, customer_name, note,
       subtotal_cents, original_cents, discount_cents, addon_cents, urgent_cents,
       freight_cents, payable_cents, paid_cents, balance_cents,
       created_at, updated_at, created_by_staff_id, business_date
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, 'open', '13800000000', '真实订单', NULL,
       500, 500, 0, 0, 0, 0, 500, 500, 0,
       $5, $5, $6::uuid, '2026-08-01'
     )`,
    [
      orderId,
      fixture.session.orgId,
      fixture.session.storeId,
      ticketNo,
      new Date("2026-08-01T00:00:00.000Z"),
      fixture.session.staffId,
    ],
  );
  await fixture.adminPool.query(
    `INSERT INTO order_lines (
       id, org_id, store_id, order_id, line_index, service_code, category_code,
       unit_price_cents, qty, line_total_cents, color, brand
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 0,
               'wash', 'shirt', 500, 1, 500, NULL, NULL)`,
    [randomUUID(), fixture.session.orgId, fixture.session.storeId, orderId],
  );
  await fixture.adminPool.query(
    `INSERT INTO payments (
       id, org_id, store_id, order_id, method, amount_cents, kind,
       ref_payment_id, staff_id, at, note, business_date
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'cash', 500, 'pay',
               NULL, $5::uuid, $6, NULL, '2026-08-01')`,
    [
      randomUUID(),
      fixture.session.orgId,
      fixture.session.storeId,
      orderId,
      fixture.session.staffId,
      new Date("2026-08-01T00:00:01.000Z"),
    ],
  );
  const store = createPgPrintJobStore(fixture.appPool, fixture.session);
  const enqueueFromOrder = store.enqueueFromOrder;
  assert.ok(enqueueFromOrder);
  const job = await enqueueFromOrder.call(store, {
    order_id: orderId,
    kind: "xp58",
    now: createdAtEpoch,
  });
  fixture.jobIds.push(job.job_id);
  assert.equal(job.ticket_no, ticketNo);
  const persisted = await fixture.adminPool.query<{
    snapshot_json: unknown;
    snapshot_sha256: string;
  }>("SELECT snapshot_json, snapshot_sha256 FROM print_jobs WHERE id = $1::uuid", [job.job_id]);
  const printSnapshot = PrintSnapshotSchema.parse(persisted.rows[0]?.snapshot_json);
  assert.equal(printSnapshot.ticket_no, ticketNo);
  assert.deepEqual(printSnapshot.payment_methods, ["cash"]);
  const hash = hashPrintSnapshot(printSnapshot);
  assert.equal(persisted.rows[0]?.snapshot_sha256, hash);
  return Object.freeze({ jobId: job.job_id, snapshot: printSnapshot, hash });
}

async function seedReceiptHead(fixture: Fixture, lastSequence: number): Promise<void> {
  await fixture.adminPool.query(
    `INSERT INTO print_device_receipt_heads (org_id, store_id, device_id, last_seq, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 0, clock_timestamp())`,
    [fixture.session.orgId, fixture.session.storeId, fixture.session.deviceId],
  );
  for (let sequence = 1; sequence <= lastSequence; sequence += 1) {
    await fixture.adminPool.query(
      `UPDATE print_device_receipt_heads SET last_seq = $4, updated_at = clock_timestamp()
        WHERE org_id = $1::uuid AND store_id = $2::uuid AND device_id = $3::uuid`,
      [fixture.session.orgId, fixture.session.storeId, fixture.session.deviceId, sequence],
    );
  }
}

function assertCapabilitySignature(dispatch: PrintDispatchData, publicKey: KeyObject): void {
  const ticket = dispatch.capability_ticket;
  const authority = Object.freeze({
    protocol_version: ticket.protocol_version,
    payload: ticket.payload,
  });
  assert.equal(
    verify(
      null,
      canonicalizeCapabilityTicketForSigning(authority),
      publicKey,
      Buffer.from(ticket.sig, "base64url"),
    ),
    true,
  );
}

function signedReceipt(
  fixture: Fixture,
  dispatch: PrintDispatchData,
  input: Readonly<{
    seq: number;
    result: "succeeded" | "failed" | "uncertain";
    cupsJobId: string | null;
    at?: string;
  }>,
): PrintExecutionReceiptRequest {
  const payload = Object.freeze({
    job_id: dispatch.capability_ticket.payload.job_id,
    device_id: fixture.session.deviceId,
    ticket_nonce: dispatch.capability_ticket.payload.nonce,
    snapshot_sha256: hashPrintSnapshot(dispatch.snapshot),
    result: input.result,
    cups_job_id: input.cupsJobId,
    seq: input.seq,
    at: input.at ?? "2026-08-01T00:00:01.000Z",
  });
  const authority = Object.freeze({ protocol_version: "1.0.0", payload });
  return Object.freeze({
    receipt: Object.freeze({
      ...authority,
      sig: sign(
        null,
        canonicalizeExecutionReceiptForSigning(authority),
        fixture.devicePrivateKey,
      ).toString("base64url"),
    }),
  });
}

test(
  "real PG recovers a lost claim response and serializes concurrent claims per device",
  { skip: urls === null },
  async () => {
    const fixture = await createFixture();
    try {
      const firstJob = await seedOrderBackedJob(fixture, 1_754_006_410);
      await seedSignedJob(fixture, new Date(1_754_006_411_000));
      const service = createPgPrintDispatchService(fixture.appPool, {
        privateKey: fixture.serverKeys.privateKey,
      });

      const claims = await Promise.all([
        service.claim(fixture.session, { supported_printer_kinds: ["xp58"] }),
        service.claim(fixture.session, { supported_printer_kinds: ["xp58"] }),
      ]);
      const first = claims[0];
      const concurrent = claims[1];
      assert.ok(first);
      assert.ok(concurrent);
      assert.equal(first.capability_ticket.payload.job_id, firstJob.jobId);
      assert.equal(concurrent.capability_ticket.payload.job_id, firstJob.jobId);
      assert.equal(
        concurrent.capability_ticket.payload.nonce,
        first.capability_ticket.payload.nonce,
      );
      assert.equal(first.capability_ticket.payload.origin, "app://local");
      if (first.capability_ticket.payload.action !== "print_job") {
        assert.fail("claim must return a print_job capability");
      }
      if (concurrent.capability_ticket.payload.action !== "print_job") {
        assert.fail("concurrent claim must return a print_job capability");
      }
      assert.equal(first.capability_ticket.payload.snapshot_sha256, firstJob.hash);
      assert.equal(first.capability_ticket.payload.recovered, false);
      assert.equal(first.capability_ticket.payload.next_receipt_seq, 1);
      assert.equal(concurrent.capability_ticket.payload.recovered, true);
      assert.equal(concurrent.capability_ticket.payload.next_receipt_seq, 1);
      assert.deepEqual(first.snapshot, firstJob.snapshot);
      assertCapabilitySignature(first, fixture.serverKeys.publicKey);
      assertCapabilitySignature(concurrent, fixture.serverKeys.publicKey);

      const restarted = createPgPrintDispatchService(fixture.appPool, {
        privateKey: fixture.serverKeys.privateKey,
      });
      const recovered = await restarted.claim(fixture.session, {
        supported_printer_kinds: ["xp58"],
      });
      assert.ok(recovered);
      if (recovered.capability_ticket.payload.action !== "print_job") {
        assert.fail("recovered claim must return a print_job capability");
      }
      assert.equal(recovered.capability_ticket.payload.job_id, firstJob.jobId);
      assert.equal(
        recovered.capability_ticket.payload.nonce,
        first.capability_ticket.payload.nonce,
      );
      assert.equal(recovered.capability_ticket.payload.recovered, true);
      assert.equal(recovered.capability_ticket.payload.next_receipt_seq, 1);
      assertCapabilitySignature(recovered, fixture.serverKeys.publicKey);

      await assert.rejects(
        () => restarted.claim(fixture.session, { supported_printer_kinds: ["dl206"] }),
        (error: unknown) => error instanceof PrintDispatchError && error.code === "binding",
      );
      const rows = await fixture.adminPool.query<{
        status: string;
        dispatch_device_id: string | null;
        attempt_count: number;
      }>(
        "SELECT status, dispatch_device_id::text, attempt_count FROM print_jobs WHERE id = ANY($1::uuid[])",
        [fixture.jobIds],
      );
      assert.equal(rows.rows.filter((row) => row.status === "printing").length, 1);
      assert.equal(rows.rows.filter((row) => row.status === "queued").length, 1);
      assert.equal(rows.rows.find((row) => row.status === "printing")?.attempt_count, 1);
      assert.equal(
        rows.rows.find((row) => row.status === "printing")?.dispatch_device_id,
        fixture.session.deviceId,
      );
    } finally {
      await fixture.close();
    }
  },
);

test(
  "real PG receipt settlement is exact-idempotent, contiguous, uncertain-safe and immutable",
  { skip: urls === null },
  async () => {
    const fixture = await createFixture();
    try {
      const firstJob = await seedSignedJob(fixture, new Date(1_754_006_410_000));
      const secondJob = await seedOrderBackedJob(fixture, 1_754_006_411);
      const auditIds: string[] = [];
      const service = createPgPrintDispatchService(fixture.appPool, {
        privateKey: fixture.serverKeys.privateKey,
        createAuditId: () => {
          const id = randomUUID();
          auditIds.push(id);
          return id;
        },
      });
      const first = await service.claim(fixture.session, { supported_printer_kinds: ["xp58"] });
      assert.ok(first);
      const succeeded = signedReceipt(fixture, first, {
        seq: 1,
        result: "succeeded",
        cupsJobId: "xp58-101",
      });
      const settled = await service.settle(fixture.session, succeeded);
      assert.equal(settled.status, "done");
      assert.equal(settled.duplicate, false);
      const replacementKeys = generateKeyPairSync("ed25519");
      const replacementSpki = replacementKeys.publicKey.export({ type: "spki", format: "der" });
      await fixture.adminPool.query(
        `UPDATE edge_devices
            SET status = 'revoked', revoked_at = clock_timestamp(),
                public_key_spki = $4, public_key_fingerprint = $5
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND device_id = $3::uuid`,
        [
          fixture.session.orgId,
          fixture.session.storeId,
          fixture.session.deviceId,
          replacementSpki.toString("base64url"),
          createHash("sha256").update(replacementSpki).digest("hex"),
        ],
      );
      assert.equal((await service.settle(fixture.session, succeeded)).duplicate, true);
      assert.equal(auditIds.length, 1, "exact duplicate must not append another audit row");

      const originalSpki = fixture.devicePublicKey.export({ type: "spki", format: "der" });
      await fixture.adminPool.query(
        `UPDATE edge_devices
            SET status = 'paired', revoked_at = NULL,
                public_key_spki = $4, public_key_fingerprint = $5
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND device_id = $3::uuid`,
        [
          fixture.session.orgId,
          fixture.session.storeId,
          fixture.session.deviceId,
          originalSpki.toString("base64url"),
          createHash("sha256").update(originalSpki).digest("hex"),
        ],
      );

      const collision = signedReceipt(fixture, first, {
        seq: 1,
        result: "succeeded",
        cupsJobId: "xp58-101",
        at: "2026-08-01T00:00:02.000Z",
      });
      await assert.rejects(
        () => service.settle(fixture.session, collision),
        (error: unknown) => error instanceof PrintDispatchError && error.code === "collision",
      );

      const second = await service.claim(fixture.session, { supported_printer_kinds: ["xp58"] });
      assert.ok(second);
      if (second.capability_ticket.payload.action !== "print_job") {
        assert.fail("next claim must return a print_job capability");
      }
      assert.equal(second.capability_ticket.payload.job_id, secondJob.jobId);
      assert.equal(second.capability_ticket.payload.recovered, false);
      assert.equal(second.capability_ticket.payload.next_receipt_seq, 2);
      const gap = signedReceipt(fixture, second, {
        seq: 3,
        result: "uncertain",
        cupsJobId: "xp58-102",
      });
      await assert.rejects(
        () => service.settle(fixture.session, gap),
        (error: unknown) => error instanceof PrintDispatchError && error.code === "sequence",
      );
      const uncertain = signedReceipt(fixture, second, {
        seq: 2,
        result: "uncertain",
        cupsJobId: "xp58-102",
      });
      assert.equal((await service.settle(fixture.session, uncertain)).status, "uncertain");
      assert.equal(auditIds.length, 2);

      await fixture.adminPool.query(
        "UPDATE orders SET customer_name = '已订正顾客' WHERE id = $1::uuid",
        [secondJob.snapshot.order_id],
      );

      const store = createPgPrintJobStore(fixture.appPool, fixture.session);
      const retried = await store.requeueFromSource?.({
        source_job_id: secondJob.jobId,
        action: "retry",
      });
      assert.ok(retried);
      fixture.jobIds.push(retried.job_id);
      assert.equal(retried.status, "queued");
      const retriedSnapshotResult = await fixture.adminPool.query<{ snapshot_json: unknown }>(
        "SELECT snapshot_json FROM print_jobs WHERE id = $1::uuid",
        [retried.job_id],
      );
      const retriedSnapshot = PrintSnapshotSchema.parse(
        retriedSnapshotResult.rows[0]?.snapshot_json,
      );
      assert.equal(retriedSnapshot.customer_name, "已订正顾客");
      assert.notDeepEqual(retriedSnapshot, secondJob.snapshot);

      for (const illegalStatus of ["done", "printing"] as const) {
        await assert.rejects(
          () =>
            withStoreGucOrCurrent(fixture.appPool, fixture.session, (client) =>
              client.query("UPDATE print_jobs SET status = $2 WHERE id = $1::uuid", [
                retried.job_id,
                illegalStatus,
              ]),
            ),
          /print_jobs_(?:dispatch|receipt)_shape_chk/u,
        );
      }

      await assert.rejects(
        () =>
          withStoreGucOrCurrent(fixture.appPool, fixture.session, (client) =>
            client.query("UPDATE print_jobs SET ticket_nonce = $2::uuid WHERE id = $1::uuid", [
              secondJob.jobId,
              randomUUID(),
            ]),
          ),
        /print dispatch binding is immutable/u,
      );
      await assert.rejects(
        () =>
          withStoreGucOrCurrent(fixture.appPool, fixture.session, (client) =>
            client.query("UPDATE print_jobs SET receipt_seq = 3 WHERE id = $1::uuid", [
              firstJob.jobId,
            ]),
          ),
        /print receipt settlement is immutable/u,
      );
      await assert.rejects(
        () =>
          withStoreGucOrCurrent(fixture.appPool, fixture.session, (client) =>
            client.query(
              `UPDATE print_device_receipt_heads SET last_seq = 1
                WHERE org_id = $1::uuid AND store_id = $2::uuid AND device_id = $3::uuid`,
              [fixture.session.orgId, fixture.session.storeId, fixture.session.deviceId],
            ),
          ),
        /print receipt head must advance monotonically/u,
      );

      const audit = await fixture.adminPool.query<{ after_json: string }>(
        `SELECT after_json FROM audit_log
          WHERE id = ANY($1::uuid[]) AND command = 'edge.print.receipt'
          ORDER BY at, id`,
        [auditIds],
      );
      assert.equal(audit.rows.length, 2);
      for (const row of audit.rows) {
        const parsed = JSON.parse(row.after_json) as Record<string, unknown>;
        assert.equal(Object.keys(parsed).filter((key) => key === "envelope_sha256").length, 1);
      }
    } finally {
      await fixture.close();
    }
  },
);

test(
  "real PG rolls back receipt settlement and sequence head when audit append fails",
  { skip: urls === null },
  async () => {
    const fixture = await createFixture();
    try {
      const auditId = randomUUID();
      await fixture.adminPool.query(
        `INSERT INTO audit_log (
           id, org_id, store_id, staff_id, via, command, idempotency_key, dry_run,
           entity, entity_id, before_json, after_json, ip, device_id, at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ui', 'test.audit.conflict',
                   NULL, false, NULL, NULL, NULL, NULL, NULL, $5::uuid, clock_timestamp())`,
        [
          auditId,
          fixture.session.orgId,
          fixture.session.storeId,
          fixture.session.staffId,
          fixture.session.deviceId,
        ],
      );
      await seedSignedJob(fixture, new Date(1_754_006_410_000));
      const service = createPgPrintDispatchService(fixture.appPool, {
        privateKey: fixture.serverKeys.privateKey,
        createAuditId: () => auditId,
      });
      const dispatch = await service.claim(fixture.session, {
        supported_printer_kinds: ["xp58"],
      });
      assert.ok(dispatch);

      await assert.rejects(
        () =>
          service.settle(
            fixture.session,
            signedReceipt(fixture, dispatch, {
              seq: 1,
              result: "succeeded",
              cupsJobId: "xp58-201",
            }),
          ),
        /duplicate key/u,
      );

      const job = await fixture.adminPool.query<{
        status: string;
        receipt_seq: string | number | null;
        receipt_envelope_sha256: string | null;
      }>(
        `SELECT status, receipt_seq, receipt_envelope_sha256
           FROM print_jobs WHERE id = $1::uuid`,
        [dispatch.capability_ticket.payload.job_id],
      );
      assert.deepEqual(job.rows[0], {
        status: "printing",
        receipt_seq: null,
        receipt_envelope_sha256: null,
      });
      const head = await fixture.adminPool.query<{ last_seq: string | number }>(
        `SELECT last_seq FROM print_device_receipt_heads
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND device_id = $3::uuid`,
        [fixture.session.orgId, fixture.session.storeId, fixture.session.deviceId],
      );
      assert.equal(Number(head.rows[0]?.last_seq), 0);
      const audit = await fixture.adminPool.query<{ command: string }>(
        "SELECT command FROM audit_log WHERE id = $1::uuid",
        [auditId],
      );
      assert.deepEqual(audit.rows, [{ command: "test.audit.conflict" }]);
    } finally {
      await fixture.close();
    }
  },
);

test(
  "real PG recovered claim signs the exact high-water successor and advances it with uncertain",
  { skip: urls === null },
  async () => {
    const fixture = await createFixture();
    try {
      await seedReceiptHead(fixture, 6);
      const job = await seedSignedJob(fixture, new Date(1_754_006_410_000));
      const service = createPgPrintDispatchService(fixture.appPool, {
        privateKey: fixture.serverKeys.privateKey,
      });
      const lost = await service.claim(fixture.session, { supported_printer_kinds: ["xp58"] });
      assert.ok(lost);
      const recovered = await service.claim(fixture.session, {
        supported_printer_kinds: ["xp58"],
      });
      assert.ok(recovered);
      if (recovered.capability_ticket.payload.action !== "print_job") {
        assert.fail("recovered claim must return a print_job capability");
      }
      assert.equal(recovered.capability_ticket.payload.job_id, job.jobId);
      assert.equal(recovered.capability_ticket.payload.recovered, true);
      assert.equal(recovered.capability_ticket.payload.next_receipt_seq, 7);

      const settlement = await service.settle(
        fixture.session,
        signedReceipt(fixture, recovered, {
          seq: 7,
          result: "uncertain",
          cupsJobId: null,
        }),
      );
      assert.equal(settlement.status, "uncertain");
      const head = await fixture.adminPool.query<{ last_seq: string | number }>(
        `SELECT last_seq FROM print_device_receipt_heads
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND device_id = $3::uuid`,
        [fixture.session.orgId, fixture.session.storeId, fixture.session.deviceId],
      );
      assert.equal(Number(head.rows[0]?.last_seq), 7);
    } finally {
      await fixture.close();
    }
  },
);
