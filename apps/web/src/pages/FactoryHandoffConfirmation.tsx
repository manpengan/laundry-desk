import type { FactoryHandoffConfirmationSummary } from "@laundry/contracts";

import { FACTORY_CHECKPOINT_LABELS } from "./factory-handoff-model.js";

const OPERATION_LABELS: Readonly<Record<FactoryHandoffConfirmationSummary["operation"], string>> =
  Object.freeze({
    batch_create: "创建交接批次",
    batch_cancel: "取消交接批次",
    checkpoint_record: "提交完整清点",
    discrepancy_resolve: "处置清点差异",
    quality_check: "记录质检结果",
  });

export function FactoryHandoffConfirmation({
  summary,
}: Readonly<{ summary: FactoryHandoffConfirmationSummary }>) {
  return (
    <div className="ld-factory-confirmation" data-testid="factory-confirmation-summary">
      <strong>{OPERATION_LABELS[summary.operation]}</strong>
      <span>工厂 {summary.factory_code}</span>
      {summary.checkpoint === null ? null : (
        <span>节点 {FACTORY_CHECKPOINT_LABELS[summary.checkpoint]}</span>
      )}
      <span>清单 {summary.counts.manifest_count} 件</span>
      {summary.operation === "checkpoint_record" || summary.operation === "discrepancy_resolve" ? (
        <span>
          匹配 {summary.counts.matched_count} · 缺少 {summary.counts.missing_count} · 夹带{" "}
          {summary.counts.unexpected_count}
        </span>
      ) : null}
      {summary.operation === "quality_check" ? (
        <span>
          合格 {summary.counts.pass_count} · 返工 {summary.counts.rework_count}
        </span>
      ) : null}
      <details>
        <summary>核对票号与条码</summary>
        <p>{summary.ticket_nos.join("、")}</p>
        <p>{summary.barcodes.join("、")}</p>
        <code>{summary.manifest_digest}</code>
      </details>
    </div>
  );
}
