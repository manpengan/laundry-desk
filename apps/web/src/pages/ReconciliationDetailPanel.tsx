import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@laundry/ui";
import type { ReconciliationDetail, ReconciliationDifference } from "@laundry/contracts";
import type { PaymentChannelPort } from "../host/payment-channel-port.js";
import {
  DIFFERENCE_LABELS,
  REVIEW_LABELS,
  exportReconciliation,
  downloadReconciliation,
} from "./channel-reconciliation-export.js";
import { ReconciliationReviewForm } from "./ReconciliationReviewForm.js";

export function ReconciliationDetailPanel({
  port,
  id,
  onOpenOrder,
}: Readonly<{
  port: PaymentChannelPort;
  id: string;
  onOpenOrder?: (id: string) => void;
}>) {
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<ReconciliationDetail | null>(null);
  const [selected, setSelected] = useState<ReconciliationDifference | null>(null);
  const [busy, setBusy] = useState(false),
    [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState("");
  const generation = useRef(0),
    life = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setBusy(true);
    setMessage("");
    try {
      const response = await port.reconciliationDetail({
        reconciliation_id: id,
        offset,
        limit: 50,
      });
      if (request !== generation.current) return;
      if (response.ok) {
        setData(response.data);
        setSelected(null);
      } else setMessage(response.error);
    } catch {
      if (request === generation.current) setMessage("无法加载差异，已保留上次结果。请重试。");
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }, [port, id, offset]);
  useEffect(() => {
    void load();
    return () => {
      ++generation.current;
    };
  }, [load]);
  useEffect(
    () => () => {
      ++life.current;
    },
    [],
  );
  const exportAll = async () => {
    const current = life.current;
    setExporting(true);
    setMessage("");
    try {
      const csv = await exportReconciliation(port, id);
      if (current === life.current) downloadReconciliation(csv, id);
    } catch (error) {
      if (current === life.current) setMessage(error instanceof Error ? error.message : "导出失败");
    } finally {
      if (current === life.current) setExporting(false);
    }
  };
  return (
    <section className="ld-panel__sub" aria-label="对账差异详情">
      <h3>全部差异与复核</h3>
      {message ? (
        <p role="alert">
          {message}{" "}
          <Button variant="secondary" onClick={() => void load()}>
            重新加载
          </Button>
        </p>
      ) : null}
      {busy ? <p role="status">正在加载差异…</p> : null}
      {data ? (
        <>
          <p>
            {data.summary.business_date} · {data.summary.channel === "wechat" ? "微信" : "支付宝"} ·
            匹配 {data.summary.matched_count} 笔 / 差异 {data.summary.mismatch_count} 笔
          </p>
          <p className="ld-panel__meta">账单校验值：{data.summary.source_sha256}</p>
          <Button variant="secondary" disabled={exporting} onClick={() => void exportAll()}>
            {exporting ? "正在导出…" : "导出全部差异 CSV"}
          </Button>
          {data.summary.mismatch_count === 0 ? <p>没有对账差异。</p> : null}
          <ol start={data.offset + 1} className="ld-panel__list">
            {data.rows.map((row) => (
              <li className="ld-panel__item" key={row.index}>
                <p>
                  {row.merchant_order} · {row.merchant_refund ?? "收款"} ·{" "}
                  {DIFFERENCE_LABELS[row.reason]}
                </p>
                <p>
                  {REVIEW_LABELS[row.review.state]}
                  {row.review.note ? `：${row.review.note}` : ""}
                </p>
                {row.order_id && onOpenOrder ? (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => onOpenOrder(row.order_id!)}
                  >
                    查看关联订单
                  </Button>
                ) : (
                  <span>无可查看的关联订单</span>
                )}
                <Button variant="secondary" disabled={busy} onClick={() => setSelected(row)}>
                  复核第 {row.index + 1} 条
                </Button>
              </li>
            ))}
          </ol>
          <nav aria-label="差异分页" className="ld-panel__actions">
            <Button
              variant="secondary"
              disabled={busy || data.offset === 0}
              onClick={() => setOffset(Math.max(0, data.offset - 50))}
            >
              上一页差异
            </Button>
            <span>
              第 {Math.floor(data.offset / 50) + 1} /{" "}
              {Math.max(1, Math.ceil(data.summary.mismatch_count / 50))} 页
            </span>
            <Button
              variant="secondary"
              disabled={busy || data.offset + 50 >= data.summary.mismatch_count}
              onClick={() => setOffset(data.offset + 50)}
            >
              下一页差异
            </Button>
          </nav>
          {selected ? (
            <ReconciliationReviewForm
              key={`${id}:${selected.index}:${selected.review.version}`}
              port={port}
              id={id}
              row={selected}
              onSaved={() => void load()}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
