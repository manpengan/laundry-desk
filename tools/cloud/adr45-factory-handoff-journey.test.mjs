import assert from "node:assert/strict";
import test from "node:test";

import { factoryHandoffBoundaryJourney } from "./adr45-factory-handoff-journey.mjs";

const BATCH_ID = "88888888-8888-4888-8888-888888888881";
const GARMENT_ID = "88888888-8888-4888-8888-888888888882";
const ORDER_ID = "88888888-8888-4888-8888-888888888883";

function api(options = {}) {
  const calls = [];
  return Object.freeze({
    calls,
    expectCommandFailure: async (_session, name, args, code) => {
      calls.push({ kind: "command", name, args, code });
    },
    query: async (_session, name) => {
      calls.push({ kind: "query", name });
      if (name === "fulfillment.batches.list") {
        return {
          batches: [
            {
              batch_id: BATCH_ID,
              factory_code: "FACTORY_01",
              status: "packing",
              version: 1,
              manifest_count: 1,
              exception_count: 0,
              updated_at: 1,
            },
          ],
          eligible_garments: [],
        };
      }
      if (name === "fulfillment.batch.get") {
        return {
          batch: {
            batch_id: BATCH_ID,
            factory_code: "FACTORY_01",
            status: "packing",
            version: 1,
            manifest_count: 1,
            exception_count: 0,
            updated_at: 1,
          },
          manifest: [
            {
              garment_id: GARMENT_ID,
              order_id: ORDER_ID,
              ticket_no: "T-001",
              barcode: options.barcode ?? "G-001",
              status: "received",
              custody_state: "store",
              member_state: "active",
              qc_status: "pending",
              ...(options.widened ? { customer_name: "不应出现" } : {}),
            },
          ],
          checkpoints: [],
          latest_attempt: null,
          quality_checks: [],
        };
      }
      assert.fail(`unexpected query ${name}`);
    },
  });
}

test("cloud boundary validates strict safe handoff views without writing a batch", async () => {
  const client = api();
  const result = await factoryHandoffBoundaryJourney(client, { session: { staffId: "admin" } });
  assert.deepEqual(result, { observedBatches: 1, observedEligible: 0 });
  const command = client.calls.find(({ kind }) => kind === "command");
  assert.equal(command.name, "fulfillment.batch.create");
  assert.equal(command.code, "VALIDATION_FAILED");
  assert.equal(command.args.customer_phone, "19900000000");
});

test("cloud boundary rejects widened customer identity fields", async () => {
  await assert.rejects(
    () => factoryHandoffBoundaryJourney(api({ widened: true }), { session: { staffId: "admin" } }),
    (error) => error?.code === "FACTORY_HANDOFF_DETAIL_INVALID",
  );
});

test("cloud boundary rejects control and UTF-8 oversized barcodes", async () => {
  for (const barcode of ["G-001\u0007", "洗".repeat(40)]) {
    await assert.rejects(
      () => factoryHandoffBoundaryJourney(api({ barcode }), { session: { staffId: "admin" } }),
      (error) => error?.code === "FACTORY_HANDOFF_GARMENT_INVALID",
    );
  }
});
