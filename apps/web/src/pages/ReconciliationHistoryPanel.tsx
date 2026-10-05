import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@laundry/ui";
import type { ReconciliationHistory } from "@laundry/contracts";
import type { PaymentChannelPort } from "../host/payment-channel-port.js";
import { ReconciliationDetailPanel } from "./ReconciliationDetailPanel.js";

export function ReconciliationHistoryPanel({
  port,
  latestId,
  onOpenOrder,
}: Readonly<{
  port: PaymentChannelPort;
  latestId?: string;
  onOpenOrder?: (id: string) => void;
}>) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [channel, setChannel] = useState<"" | "wechat" | "alipay">("");
  const [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<ReconciliationHistory | null>(null),
    [message, setMessage] = useState("");
  const generation = useRef(0);
  const load = useCallback(async () => {
    if (!open) return;
    const request = ++generation.current;
    setMessage("");
    setBusy(true);
    try {
      const response = await port.reconciliationHistory({
        offset,
        limit: 25,
        ...(channel ? { channel } : {}),
        ...(from ? { date_from: from } : {}),
        ...(to ? { date_to: to } : {}),
      });
      if (request !== generation.current) return;
      if (response.ok) setData(response.data);
      else setMessage(response.error);
    } catch {
      if (request === generation.current) setMessage("对账历史加载失败，已保留上次结果。请重试。");
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }, [open, port, offset, channel, from, to]);
  useEffect(() => {
    void load();
    return () => {
      ++generation.current;
    };
  }, [load, latestId]);
  useEffect(() => {
    if (latestId) {
      setOpen(true);
      setSelected(latestId);
    }
  }, [latestId]);
  return (
    <section className="ld-panel__sub" aria-label="历史对账">
      <Button variant="secondary" onClick={() => setOpen(!open)}>
        {open ? "收起历史对账" : "查看历史对账与复核"}
      </Button>
      {open ? (
        <>
          <div className="ld-panel__grid">
            <label className="ld-field">
              <span>历史渠道</span>
              <select
                className="ld-input"
                value={channel}
                onChange={(e) => {
                  setChannel(
                    e.target.value === "wechat"
                      ? "wechat"
                      : e.target.value === "alipay"
                        ? "alipay"
                        : "",
                  );
                  setOffset(0);
                }}
              >
                <option value="">全部</option>
                <option value="wechat">微信</option>
                <option value="alipay">支付宝</option>
              </select>
            </label>
            <label className="ld-field">
              <span>开始日期</span>
              <input
                className="ld-input"
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setOffset(0);
                }}
              />
            </label>
            <label className="ld-field">
              <span>结束日期</span>
              <input
                className="ld-input"
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setOffset(0);
                }}
              />
            </label>
          </div>
          {busy ? <p role="status">正在加载对账历史…</p> : null}
          {message ? (
            <p role="alert">
              {message}{" "}
              <Button variant="secondary" onClick={() => void load()}>
                重试历史
              </Button>
            </p>
          ) : null}
          {data ? (
            <>
              {!data.total && !busy && !message ? <p>此范围没有对账记录。</p> : null}
              <ul className="ld-panel__list">
                {data.rows.map((row) => (
                  <li className="ld-panel__item" key={row.reconciliation_id}>
                    <Button variant="secondary" onClick={() => setSelected(row.reconciliation_id)}>
                      {row.business_date} · {row.channel === "wechat" ? "微信" : "支付宝"} · 差异{" "}
                      {row.mismatch_count} 笔 · {new Date(row.created_at).toLocaleString()}
                    </Button>
                  </li>
                ))}
              </ul>
              <nav className="ld-panel__actions" aria-label="对账历史分页">
                <Button
                  variant="secondary"
                  disabled={busy || data.offset === 0}
                  onClick={() => setOffset(Math.max(0, data.offset - 25))}
                >
                  上一页记录
                </Button>
                <span>共 {data.total} 条</span>
                <Button
                  variant="secondary"
                  disabled={busy || data.offset + 25 >= data.total || data.offset + 25 > 10000}
                  onClick={() => setOffset(data.offset + 25)}
                >
                  下一页记录
                </Button>
              </nav>
              {data.total > 10000 ? <p>记录较多，请按日期缩小范围。</p> : null}
            </>
          ) : null}
          {selected ? (
            <ReconciliationDetailPanel
              key={selected}
              port={port}
              id={selected}
              {...(onOpenOrder ? { onOpenOrder } : {})}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}
