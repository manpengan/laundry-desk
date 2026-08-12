import type { FulfillmentOperationConfirmationSummary } from "@laundry/contracts";

import { FULFILLMENT_STATUS_LABELS } from "./fulfillment-model.js";

export function readFulfillmentOperationSummary(
  value: unknown,
): FulfillmentOperationConfirmationSummary | null {
  return typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "fulfillment_operation"
    ? (value as FulfillmentOperationConfirmationSummary)
    : null;
}

const OPERATION_LABELS: Readonly<
  Record<FulfillmentOperationConfirmationSummary["operation"], string>
> = Object.freeze({
  bulk_transition: "批量流转",
  rework: "返工登记",
  incident_record: "异常登记",
  mark_lost: "标记丢损",
});

const INCIDENT_LABELS = Object.freeze({
  damage: "损坏",
  other: "其他",
});

export function FulfillmentOperationConfirmation({
  summary,
}: Readonly<{ summary: FulfillmentOperationConfirmationSummary }>) {
  return (
    <div className="ld-factory-confirmation" data-testid="fulfillment-confirmation-summary">
      <strong>{OPERATION_LABELS[summary.operation]}</strong>
      <span>衣物 {summary.garment_ids.length} 件</span>
      {summary.target_status === null ? null : (
        <span>目标状态 {FULFILLMENT_STATUS_LABELS[summary.target_status]}</span>
      )}
      {summary.incident_kind === null ? null : (
        <span>异常类型 {INCIDENT_LABELS[summary.incident_kind]}</span>
      )}
      {summary.compensation_cents === null ? null : (
        <span>赔付 {summary.compensation_cents} 分</span>
      )}
      {summary.reason === null ? null : <span>原因 {summary.reason}</span>}
      {summary.note === null ? null : <span>备注 {summary.note}</span>}
      <details>
        <summary>核对票号与条码</summary>
        <p>{summary.ticket_nos.join("、")}</p>
        <p>{summary.barcodes.join("、")}</p>
        <code>{summary.manifest_digest}</code>
      </details>
    </div>
  );
}
