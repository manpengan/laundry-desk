import { useRef, useEffect, useState } from "react";
import { Button } from "@laundry/ui";
import type { ReconciliationDifference } from "@laundry/contracts";
import type { PaymentChannelPort } from "../host/payment-channel-port.js";
import { REVIEW_LABELS } from "./channel-reconciliation-export.js";

export function ReconciliationReviewForm({
  port,
  id,
  row,
  onSaved,
}: Readonly<{
  port: PaymentChannelPort;
  id: string;
  row: ReconciliationDifference;
  onSaved: () => void;
}>) {
  const [state, setState] = useState(row.review.state);
  const [note, setNote] = useState(row.review.note);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [latestReview, setLatestReview] = useState(row.review);
  const [refreshed, setRefreshed] = useState(false);
  const lifetime = useRef(0);
  const saving = useRef(false);
  useEffect(
    () => () => {
      ++lifetime.current;
    },
    [],
  );
  const save = async () => {
    if (saving.current || !note.trim()) return;
    saving.current = true;
    setBusy(true);
    setMessage("");
    const current = lifetime.current;
    try {
      const response = await port.reconciliationReview({
        reconciliation_id: id,
        index: row.index,
        expected_version: latestReview.version,
        state,
        note,
      });
      if (current !== lifetime.current) return;
      if (response.ok) onSaved();
      else
        setMessage(
          response.code === "IDEMPOTENCY_CONFLICT"
            ? "其他人已更新此差异，请重新加载后核对；当前备注仍保留。"
            : response.error,
        );
    } catch {
      if (current === lifetime.current)
        setMessage("保存结果未确认，请重新加载核对后再试。当前备注仍保留。");
    } finally {
      if (current === lifetime.current) {
        saving.current = false;
        setBusy(false);
      }
    }
  };
  const reloadReview = async () => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    const current = lifetime.current;
    try {
      const response = await port.reconciliationDetail({
        reconciliation_id: id,
        offset: row.index,
        limit: 1,
      });
      if (current !== lifetime.current) return;
      const latest = response.ok
        ? response.data.rows.find((item) => item.index === row.index)
        : null;
      if (!latest) {
        setMessage(response.ok ? "未找到原差异，请重新打开此批次。" : response.error);
        return;
      }
      setLatestReview(latest.review);
      setRefreshed(true);
      setMessage("");
    } catch {
      if (current === lifetime.current) setMessage("读取最新复核失败，草稿已保留。请重试。");
    } finally {
      if (current === lifetime.current) {
        saving.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <fieldset disabled={busy} className="ld-panel__sub">
      <legend>复核第 {row.index + 1} 条差异</legend>
      <label className="ld-field">
        <span>复核状态</span>
        <select
          className="ld-input"
          value={state}
          onChange={(e) => {
            const value = e.target.value;
            if (value === "open" || value === "investigating" || value === "resolved")
              setState(value);
          }}
        >
          {Object.entries(REVIEW_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="ld-field">
        <span>复核备注（必填）</span>
        <textarea
          className="ld-input"
          value={note}
          maxLength={1000}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <p>复核仅记录处理情况，不改变原始账单和资金流水。</p>
      {refreshed ? (
        <p role="status">
          最新记录：{REVIEW_LABELS[latestReview.state]} · {latestReview.note || "无备注"}
          。你的草稿已保留，请核对后保存。
        </p>
      ) : null}
      <Button disabled={busy || !note.trim()} onClick={() => void save()}>
        保存复核
      </Button>
      {message ? (
        <>
          <p role="alert">{message}</p>
          <Button variant="secondary" onClick={() => void reloadReview()}>
            读取最新复核（保留草稿）
          </Button>
        </>
      ) : null}
    </fieldset>
  );
}
