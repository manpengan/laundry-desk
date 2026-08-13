import { Button } from "@laundry/ui";
import type { ChangeEvent } from "react";

import { DELIVERY_TASK_LEG_LABELS } from "../pages/delivery-task-model.js";
import { DELIVERY_EVIDENCE_REASON_LABELS } from "./mobile-delivery-evidence-model.js";
import type { MobileTaskDetail } from "./mobile-task-model.js";
import type {
  MobileDeliveryEvidencePending,
  useMobileDeliveryEvidence,
} from "./use-mobile-delivery-evidence.js";

type EvidenceWorkbench = ReturnType<typeof useMobileDeliveryEvidence>;

const eventLabel = Object.freeze({ pickup: "取件", delivered: "送达", exception: "异常" });

export function MobileDeliveryEvidenceCard({
  detail,
  evidence,
  online,
}: Readonly<{ detail: MobileTaskDetail | null; evidence: EvidenceWorkbench; online: boolean }>) {
  if (detail === null || !["accepted", "completed"].includes(detail.task.status)) return null;
  const editable = detail.task.status === "accepted";
  const selectFile = (kind: "photo" | "signature") => (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file !== undefined) void evidence.upload(kind, file);
  };
  return (
    <section
      className="ld-mobile-task-detail is-detail-open"
      aria-labelledby="delivery-evidence-title"
    >
      <div className="ld-mobile-task-detail__heading">
        <div>
          <span className="ld-mobile-task-detail__eyebrow">当前接单员工专属</span>
          <h2 id="delivery-evidence-title">交付证据</h2>
        </div>
        <span className="ld-mobile-task-status">{DELIVERY_TASK_LEG_LABELS[detail.task.leg]}</span>
      </div>

      {editable ? (
        <div className="ld-mobile-task-actions">
          <fieldset disabled={!online || evidence.busy}>
            <legend>本次记录</legend>
            {evidence.canComplete ? (
              <label>
                <input
                  type="radio"
                  name="delivery-evidence-mode"
                  checked={evidence.mode === "complete"}
                  onChange={() => evidence.setMode("complete")}
                />
                {detail.task.leg === "pickup" ? "取件并完成任务" : "送达并完成任务"}
              </label>
            ) : null}
            <label>
              <input
                type="radio"
                name="delivery-evidence-mode"
                checked={evidence.mode === "exception"}
                onChange={() => evidence.setMode("exception")}
              />
              仅记录现场异常
            </label>
          </fieldset>
          {evidence.mode === "exception" ? (
            <label>
              异常原因
              <select
                value={evidence.reason}
                disabled={!online || evidence.busy}
                onChange={(event) =>
                  evidence.setReason(
                    event.target.value as keyof typeof DELIVERY_EVIDENCE_REASON_LABELS,
                  )
                }
              >
                {Object.entries(DELIVERY_EVIDENCE_REASON_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            disabled={!online || evidence.busy}
            onClick={evidence.captureGps}
          >
            {evidence.gps === null ? "采集本次 GPS 定点" : "重新采集 GPS 定点"}
          </Button>
          <span role="status">{evidence.gps === null ? "尚未采集定位" : "已采集定位与精度"}</span>
          <label className="ld-button ld-button--secondary">
            选择现场照片
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={!online || evidence.busy}
              onChange={selectFile("photo")}
            />
          </label>
          {detail.task.leg === "return" ? (
            <label className="ld-button ld-button--secondary">
              选择顾客签名图片
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={!online || evidence.busy}
                onChange={selectFile("signature")}
              />
            </label>
          ) : null}
          <span role="status">
            照片 {evidence.attachments.filter(({ kind }) => kind === "photo").length} · 签名{" "}
            {evidence.attachments.filter(({ kind }) => kind === "signature").length}
          </span>
          <Button
            type="button"
            size="lg"
            disabled={
              !online || evidence.busy || (evidence.mode === "complete" && !evidence.canComplete)
            }
            onClick={() => void evidence.submit()}
          >
            {evidence.busy ? "处理中…" : "提交交付证据"}
          </Button>
          <small>定位和文件只在点击上述按钮后请求；离线时不会排队写入。</small>
        </div>
      ) : null}

      <div className="ld-mobile-task-facts" aria-live="polite">
        <h3>已记录证据</h3>
        {evidence.loading ? <p>读取中…</p> : null}
        {!evidence.loading && evidence.items.length === 0 ? <p>暂无证据记录。</p> : null}
        {evidence.items.map((item) => (
          <article key={item.delivery_evidence_id}>
            <strong>{eventLabel[item.event_kind]}</strong>
            <span>{new Date(item.recorded_at * 1_000).toLocaleString()}</span>
            <span>
              GPS {item.gps === null ? "无" : "有"} · 照片{" "}
              {item.attachments.filter(({ kind }) => kind === "photo").length} · 签名{" "}
              {item.attachments.filter(({ kind }) => kind === "signature").length}
            </span>
            {item.exception_reason === null ? null : (
              <span>{DELIVERY_EVIDENCE_REASON_LABELS[item.exception_reason]}</span>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

export function MobileDeliveryEvidenceSummary({
  pending,
}: Readonly<{ pending: MobileDeliveryEvidencePending }>) {
  const summary = pending.summary;
  return (
    <dl className="ld-mobile-task-confirmation">
      <div>
        <dt>证据 / 配送订单</dt>
        <dd>
          {summary.delivery_evidence_id} / {summary.delivery_order_id}
        </dd>
      </div>
      <div>
        <dt>配送任务</dt>
        <dd>{summary.delivery_task_id}</dd>
      </div>
      <div>
        <dt>任务腿 / 执行员工</dt>
        <dd>
          {DELIVERY_TASK_LEG_LABELS[summary.leg]} / {summary.assignee_staff_id}
        </dd>
      </div>
      <div>
        <dt>订单版本 / 任务版本</dt>
        <dd>
          v{summary.delivery_order_version} / v{summary.delivery_task_version}
        </dd>
      </div>
      <div>
        <dt>事件 / 结果</dt>
        <dd>
          {eventLabel[summary.event_kind]} /{" "}
          {summary.outcome === "complete_leg" ? "原子完成配送腿" : "仅追加证据"}
        </dd>
      </div>
      <div>
        <dt>现场采集时间</dt>
        <dd>{new Date(summary.captured_at * 1_000).toLocaleString()}</dd>
      </div>
      <div>
        <dt>证据构成</dt>
        <dd>
          GPS {summary.has_gps ? "有" : "无"} · 照片 {summary.photo_count} · 签名{" "}
          {summary.signature_count}
        </dd>
      </div>
      {summary.exception_reason === null ? null : (
        <div>
          <dt>异常原因</dt>
          <dd>{DELIVERY_EVIDENCE_REASON_LABELS[summary.exception_reason]}</dd>
        </div>
      )}
    </dl>
  );
}
