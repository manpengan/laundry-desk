import assert from "node:assert/strict";
import test from "node:test";

import type {
  FactoryHandoffBatchGetResult,
  FactoryHandoffConfirmationSummary,
  FulfillmentOperationConfirmationSummary,
} from "@laundry/contracts";
import { renderToStaticMarkup } from "react-dom/server";

import { FactoryHandoffConfirmation } from "./FactoryHandoffConfirmation.js";
import { FactoryBatchDetail } from "./FactoryBatchDetail.js";
import { FulfillmentOperationConfirmation } from "./FulfillmentOperationConfirmation.js";

const DIGEST = "a".repeat(64);
const GARMENT_ID = "10000000-0000-4000-8000-000000000001";

function renderBatchDetail(detail: FactoryHandoffBatchGetResult): string {
  const noop = () => undefined;
  return renderToStaticMarkup(
    <FactoryBatchDetail
      detail={detail}
      scanDraft=""
      scannedBarcodes={[]}
      qcSelected={new Set()}
      qcReason="stain_remaining"
      cancelReason="operational_error"
      discrepancyReason="recount_verified"
      canResolveDiscrepancy
      busy={false}
      onScanDraftChange={noop}
      onAddScan={noop}
      onRemoveScan={noop}
      onRecordCheckpoint={noop}
      onResolve={noop}
      onToggleQc={noop}
      onQcReasonChange={noop}
      onCancelReasonChange={noop}
      onDiscrepancyReasonChange={noop}
      onRecordQuality={noop}
      onCancel={noop}
      onBack={noop}
      onRefresh={noop}
    />,
  );
}

test("factory confirmation renders the server-frozen manifest without customer identity", () => {
  const summary: FactoryHandoffConfirmationSummary = {
    kind: "factory_handoff",
    operation: "checkpoint_record",
    batch_id: "20000000-0000-4000-8000-000000000001",
    expected_version: 2,
    checkpoint: "factory_receive",
    factory_code: "FACTORY_01",
    ticket_nos: ["T-001"],
    barcodes: ["G-001"],
    counts: {
      manifest_count: 1,
      scan_count: 1,
      matched_count: 1,
      missing_count: 0,
      unexpected_count: 0,
      pass_count: 0,
      rework_count: 0,
    },
    manifest_digest: DIGEST,
  };

  const html = renderToStaticMarkup(<FactoryHandoffConfirmation summary={summary} />);
  assert.match(html, /工厂收件/u);
  assert.match(html, /T-001/u);
  assert.match(html, /G-001/u);
  assert.doesNotMatch(html, /customer|phone|客户姓名|手机号/iu);
});

test("legacy fulfillment confirmation renders the exact frozen operation", () => {
  const summary: FulfillmentOperationConfirmationSummary = {
    kind: "fulfillment_operation",
    operation: "rework",
    garment_ids: [GARMENT_ID],
    ticket_nos: ["T-002"],
    barcodes: ["G-002"],
    target_status: null,
    incident_kind: null,
    compensation_cents: null,
    reason: "重新去渍",
    note: null,
    manifest_digest: DIGEST,
  };

  const html = renderToStaticMarkup(<FulfillmentOperationConfirmation summary={summary} />);
  assert.match(html, /返工登记/u);
  assert.match(html, /重新去渍/u);
  assert.match(html, /T-002/u);
  assert.match(html, /G-002/u);
});

test("an unresolved discrepancy hides ordinary rescanning and leaves only controlled resolution", () => {
  const detail: FactoryHandoffBatchGetResult = {
    batch: {
      batch_id: "20000000-0000-4000-8000-000000000001",
      factory_code: "FACTORY_01",
      status: "factory_received",
      version: 1,
      manifest_count: 1,
      exception_count: 0,
      updated_at: 1_700_000_000,
    },
    manifest: [
      {
        garment_id: GARMENT_ID,
        order_id: "30000000-0000-4000-8000-000000000001",
        ticket_no: "T-001",
        barcode: "G-001",
        status: "washing",
        custody_state: "factory",
        member_state: "active",
        qc_status: "pending",
      },
    ],
    checkpoints: [],
    latest_attempt: {
      attempt_id: "40000000-0000-4000-8000-000000000001",
      checkpoint: "factory_dispatch",
      outcome: "discrepancy",
      matched_barcodes: [],
      missing_barcodes: ["G-001"],
      unexpected_barcodes: [],
      recorded_at: 1_700_000_001,
    },
    quality_checks: [],
  };
  const html = renderBatchDetail(detail);
  assert.match(html, /异常 0/u);
  assert.match(html, /清点差异，批次未推进/u);
  assert.match(html, /双人复核并处置差异/u);
  assert.doesNotMatch(html, /提交完整清点/u);
  assert.doesNotMatch(html, /name="factory-barcode-scan"/u);
  assert.doesNotMatch(html, /质检与返工/u);
});

test("factory dispatch scanning stays hidden until every active garment passes QC", () => {
  const detail: FactoryHandoffBatchGetResult = {
    batch: {
      batch_id: "20000000-0000-4000-8000-000000000001",
      factory_code: "FACTORY_01",
      status: "factory_received",
      version: 2,
      manifest_count: 1,
      exception_count: 0,
      updated_at: 1_700_000_000,
    },
    manifest: [
      {
        garment_id: GARMENT_ID,
        order_id: "30000000-0000-4000-8000-000000000001",
        ticket_no: "T-001",
        barcode: "G-001",
        status: "washing",
        custody_state: "factory",
        member_state: "active",
        qc_status: "pending",
      },
    ],
    checkpoints: [],
    latest_attempt: null,
    quality_checks: [],
  };

  const blocked = renderBatchDetail(detail);
  assert.match(blocked, /出厂清点尚未开放/u);
  assert.match(blocked, /全部在批衣物质检合格/u);
  assert.doesNotMatch(blocked, /提交完整清点/u);
  assert.doesNotMatch(blocked, /name="factory-barcode-scan"/u);

  const ready = renderBatchDetail({
    ...detail,
    manifest: detail.manifest.map((garment) => ({
      ...garment,
      status: "ready" as const,
      qc_status: "pass" as const,
    })),
  });
  assert.match(ready, /工厂发回/u);
  assert.match(ready, /提交完整清点/u);
  assert.match(ready, /name="factory-barcode-scan"/u);
  assert.doesNotMatch(ready, /出厂清点尚未开放/u);
});
