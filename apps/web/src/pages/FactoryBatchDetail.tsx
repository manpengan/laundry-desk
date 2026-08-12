import type {
  FactoryBatchCancelInput,
  FactoryHandoffBatchGetResult,
  FactoryHandoffDiscrepancyResolveInput,
  GarmentQualityReworkReason,
} from "@laundry/contracts";
import { Button, Input } from "@laundry/ui";

import {
  FACTORY_BATCH_STATUS_LABELS,
  FACTORY_CHECKPOINT_LABELS,
  nextFactoryCheckpoint,
} from "./factory-handoff-model.js";

export type FactoryBatchDetailProps = Readonly<{
  detail: FactoryHandoffBatchGetResult;
  scanDraft: string;
  scannedBarcodes: readonly string[];
  qcSelected: ReadonlySet<string>;
  qcReason: GarmentQualityReworkReason;
  cancelReason: FactoryBatchCancelInput["reason_code"];
  discrepancyReason: FactoryHandoffDiscrepancyResolveInput["reason_code"];
  canResolveDiscrepancy: boolean;
  busy: boolean;
  onScanDraftChange: (value: string) => void;
  onAddScan: () => void;
  onRemoveScan: (barcode: string) => void;
  onRecordCheckpoint: () => void;
  onResolve: () => void;
  onToggleQc: (garmentId: string, selected: boolean) => void;
  onQcReasonChange: (reason: GarmentQualityReworkReason) => void;
  onCancelReasonChange: (reason: FactoryBatchCancelInput["reason_code"]) => void;
  onDiscrepancyReasonChange: (reason: FactoryHandoffDiscrepancyResolveInput["reason_code"]) => void;
  onRecordQuality: (outcome: "pass" | "rework") => void;
  onCancel: () => void;
  onBack: () => void;
  onRefresh: () => void;
}>;

export function FactoryBatchDetail(props: FactoryBatchDetailProps) {
  const { detail, busy } = props;
  const checkpoint = nextFactoryCheckpoint(detail.batch.status);
  const activeManifest = detail.manifest.filter((garment) => garment.member_state === "active");
  const discrepancy = detail.latest_attempt?.outcome === "discrepancy";
  const checkpointReady =
    checkpoint !== "factory_dispatch" ||
    (activeManifest.length > 0 &&
      activeManifest.every(
        (garment) => garment.qc_status === "pass" && garment.status === "ready",
      ));
  return (
    <section className="ld-factory-detail" data-testid="factory-batch-detail">
      <header className="ld-factory-detail__header">
        <div>
          <h2>{detail.batch.factory_code}</h2>
          <p>
            {FACTORY_BATCH_STATUS_LABELS[detail.batch.status]} · 版本 {detail.batch.version} ·{" "}
            {detail.batch.manifest_count} 件 · 异常 {detail.batch.exception_count}
          </p>
        </div>
        <Button variant="secondary" type="button" onClick={props.onBack} disabled={busy}>
          返回批次
        </Button>
        <Button variant="secondary" type="button" onClick={props.onRefresh} disabled={busy}>
          刷新
        </Button>
      </header>

      <div className="ld-factory-manifest">
        {detail.manifest.map((garment) => (
          <label key={garment.garment_id} className="ld-factory-garment">
            <input
              type="checkbox"
              checked={props.qcSelected.has(garment.garment_id)}
              onChange={(event) => props.onToggleQc(garment.garment_id, event.target.checked)}
              disabled={busy || garment.member_state !== "active"}
            />
            <strong>{garment.ticket_no}</strong>
            <span>{garment.barcode}</span>
            <small>
              {garment.member_state} · {garment.qc_status} · {garment.custody_state}
            </small>
          </label>
        ))}
      </div>

      {checkpoint === null || discrepancy || !checkpointReady ? null : (
        <section className="ld-factory-card" aria-label="完整清点">
          <h3>{FACTORY_CHECKPOINT_LABELS[checkpoint]}</h3>
          <p>
            已扫 {props.scannedBarcodes.length} / 应扫 {activeManifest.length}
          </p>
          <div className="ld-factory-scan">
            <Input
              name="factory-barcode-scan"
              label="扫描条码"
              value={props.scanDraft}
              onChange={(event) => props.onScanDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  props.onAddScan();
                }
              }}
              disabled={busy}
            />
            <Button type="button" onClick={props.onAddScan} disabled={busy}>
              加入扫描
            </Button>
          </div>
          <div className="ld-factory-scan-list">
            {props.scannedBarcodes.map((barcode) => (
              <button
                type="button"
                key={barcode}
                onClick={() => props.onRemoveScan(barcode)}
                disabled={busy}
              >
                {barcode} ×
              </button>
            ))}
          </div>
          <Button
            type="button"
            onClick={props.onRecordCheckpoint}
            disabled={busy || props.scannedBarcodes.length === 0}
          >
            提交完整清点
          </Button>
        </section>
      )}

      {checkpoint === "factory_dispatch" && !discrepancy && !checkpointReady ? (
        <section className="ld-factory-card" role="status" aria-label="出厂清点条件">
          <h3>出厂清点尚未开放</h3>
          <p>全部在批衣物质检合格并进入待取状态后，才能执行工厂发出清点。</p>
        </section>
      ) : null}

      {discrepancy ? (
        <section className="ld-factory-discrepancy" role="alert">
          <h3>清点差异，批次未推进</h3>
          <p>缺少：{detail.latest_attempt?.missing_barcodes.join("、") || "无"}</p>
          <p>夹带：{detail.latest_attempt?.unexpected_barcodes.join("、") || "无"}</p>
          {props.canResolveDiscrepancy ? (
            <>
              <label>
                <span>处置依据</span>
                <select
                  value={props.discrepancyReason}
                  onChange={(event) =>
                    props.onDiscrepancyReasonChange(
                      event.target.value as FactoryHandoffDiscrepancyResolveInput["reason_code"],
                    )
                  }
                  disabled={busy}
                >
                  <option value="manifest_corrected">清单纠正</option>
                  <option value="recount_verified">复点确认</option>
                  <option value="exception_accepted">接受异常隔离</option>
                </select>
              </label>
              <Button variant="danger" type="button" onClick={props.onResolve} disabled={busy}>
                双人复核并处置差异
              </Button>
            </>
          ) : (
            <p>请由管理员发起双人复核处置。</p>
          )}
        </section>
      ) : null}

      {detail.batch.status === "factory_received" && !discrepancy ? (
        <section className="ld-factory-card" aria-label="质量检查">
          <h3>质检与返工</h3>
          <p>已选 {props.qcSelected.size} 件（单次最多 50 件）</p>
          <label>
            <span>返工原因</span>
            <select
              value={props.qcReason}
              onChange={(event) =>
                props.onQcReasonChange(event.target.value as GarmentQualityReworkReason)
              }
              disabled={busy}
            >
              <option value="stain_remaining">污渍残留</option>
              <option value="damage_found">发现损坏</option>
              <option value="finish_incomplete">整理未完成</option>
              <option value="other">其他</option>
            </select>
          </label>
          <Button
            type="button"
            onClick={() => props.onRecordQuality("pass")}
            disabled={busy || props.qcSelected.size === 0 || props.qcSelected.size > 50}
          >
            所选质检合格
          </Button>
          <Button
            variant="secondary"
            type="button"
            onClick={() => props.onRecordQuality("rework")}
            disabled={busy || props.qcSelected.size === 0 || props.qcSelected.size > 50}
          >
            所选退回返工
          </Button>
        </section>
      ) : null}

      <ol className="ld-factory-checkpoints" aria-label="交接节点证据">
        {detail.checkpoints.map((row) => (
          <li key={row.checkpoint}>
            <strong>{FACTORY_CHECKPOINT_LABELS[row.checkpoint]}</strong>
            <span>匹配 {row.matched_count}</span>
            <span>缺少 {row.missing_count}</span>
            <span>夹带 {row.unexpected_count}</span>
          </li>
        ))}
      </ol>

      {detail.batch.status === "packing" ? (
        <section className="ld-factory-card" aria-label="取消未发出批次">
          <label>
            <span>取消原因</span>
            <select
              value={props.cancelReason}
              onChange={(event) =>
                props.onCancelReasonChange(
                  event.target.value as FactoryBatchCancelInput["reason_code"],
                )
              }
              disabled={busy}
            >
              <option value="duplicate_batch">重复批次</option>
              <option value="customer_request">客户要求</option>
              <option value="operational_error">操作错误</option>
            </select>
          </label>
          <Button variant="danger" type="button" onClick={props.onCancel} disabled={busy}>
            取消未发出批次
          </Button>
        </section>
      ) : null}
    </section>
  );
}
