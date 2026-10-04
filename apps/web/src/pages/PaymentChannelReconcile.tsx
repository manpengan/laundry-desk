import { useEffect, useRef, useState } from "react";
import { Button } from "@laundry/ui";
import type { ChannelReconciliation } from "@laundry/contracts";
import type { PaymentChannelPort } from "../host/payment-channel-port.js";
import {
  decodeStatement,
  readChannelStatement,
  type ParsedStatement,
} from "./channel-statement.js";
const SOURCE_LABELS = {
  canonical: "规范 CSV",
  wechat: "微信支付交易账单",
  alipay: "支付宝业务明细",
} as const;
const labels = {
  missing_local: "本机缺少流水",
  missing_provider: "渠道账单缺少流水",
  amount_mismatch: "金额不同",
  state_mismatch: "状态不同",
  reference_mismatch: "流水号不同",
  duplicate_provider: "渠道流水重复",
};
export function PaymentChannelReconcile({ port }: Readonly<{ port: PaymentChannelPort }>) {
  const [channel, setChannel] = useState<"wechat" | "alipay">("wechat");
  const [date, setDate] = useState("");
  const [parsed, setParsed] = useState<ParsedStatement | null>(null);
  const input = parsed?.input ?? null;
  const [result, setResult] = useState<ChannelReconciliation | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const generation = useRef(0),
    fileGeneration = useRef(0);
  useEffect(() => {
    ++generation.current;
    return () => {
      ++generation.current;
      ++fileGeneration.current;
    };
  }, []);
  const readFile = async (file: File | undefined) => {
    const current = ++fileGeneration.current,
      life = generation.current;
    setParsed(null);
    setResult(null);
    setMessage("");
    if (!file || file.size > 2_000_000) {
      setMessage("请选择不超过 2 MB 的账单文件；交易多时请按日导出。");
      return;
    }
    try {
      const text = decodeStatement(await file.arrayBuffer());
      if (current !== fileGeneration.current || life !== generation.current) return;
      setParsed(readChannelStatement(channel, date, text));
    } catch (error) {
      if (current === fileGeneration.current && life === generation.current)
        setMessage(error instanceof Error ? error.message : "文件读取失败");
    }
  };
  const reconcile = async () => {
    if (!input || busy) return;
    const current = generation.current;
    setBusy(true);
    setMessage("");
    const response = await port.reconcile(input);
    if (current !== generation.current) return;
    setBusy(false);
    if (response.ok) setResult(response.data);
    else setMessage(response.error);
  };
  return (
    <section className="ld-panel" aria-label="支付账单对账">
      <p className="ld-panel__lead">
        从商户后台下载当天账单后直接选择文件：微信支付选“交易账单（全部）”，支付宝选“业务明细”。
        导入只核对本机流水并保存差异，不会自动补收、退款或改账。
      </p>
      <details className="ld-panel__advanced">
        <summary>高级：手工整理的规范 CSV</summary>
        <p className="ld-panel__lead">
          也可整理为下列五列的 UTF-8 CSV：金额单位为分，类型填“收款”或“退款”，收款的退款号留空。
        </p>
        <p className="ld-panel__code">商户订单号,渠道订单号,金额分,类型,商户退款号</p>
      </details>
      <div className="ld-panel__grid">
        <label className="ld-field">
          <span className="ld-field__label">渠道</span>
          <select
            className="ld-input"
            value={channel}
            disabled={busy}
            onChange={(e) => {
              ++fileGeneration.current;
              setChannel(e.target.value === "alipay" ? "alipay" : "wechat");
              setParsed(null);
              setResult(null);
            }}
          >
            <option value="wechat">微信</option>
            <option value="alipay">支付宝</option>
          </select>
        </label>
        <label className="ld-field">
          <span className="ld-field__label">账单日期</span>
          <input
            className="ld-input"
            type="date"
            value={date}
            disabled={busy}
            onChange={(e) => {
              ++fileGeneration.current;
              setDate(e.target.value);
              setParsed(null);
              setResult(null);
            }}
          />
        </label>
        <label className="ld-field">
          <span className="ld-field__label">选择账单文件</span>
          <input
            className="ld-input"
            type="file"
            accept=".csv,text/csv"
            disabled={busy || !date}
            onChange={(e) => {
              void readFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {parsed && (
        <p className="ld-panel__note">
          {SOURCE_LABELS[parsed.source]}：已校验 {parsed.input.rows.length} 笔，日期{" "}
          {parsed.input.business_date}
          {parsed.skipped > 0 ? `，跳过 ${parsed.skipped} 行非本系统发起的流水` : ""}，待提交核对。
        </p>
      )}
      <div className="ld-panel__actions">
        <Button disabled={busy || !input} onClick={() => void reconcile()}>
          提交对账
        </Button>
      </div>
      {message && (
        <p className="ld-panel__note ld-panel__note--warn" role="alert">
          {message}
        </p>
      )}
      {result && (
        <div className="ld-panel__sub">
          <p className="ld-panel__note ld-panel__note--ok" role="status">
            匹配 {result.matched_count} 笔，差异 {result.mismatches.length} 笔。
          </p>
          <p className="ld-panel__meta">账单校验值：{result.source_sha256}</p>
          <ul className="ld-panel__list">
            {result.mismatches.slice(0, 100).map((row, index) => (
              <li className="ld-panel__item" key={`${row.merchant_order}:${index}`}>
                {row.merchant_order} · {row.merchant_refund ?? "收款"} · {labels[row.reason]}
              </li>
            ))}
          </ul>
          {result.mismatches.length > 100 && (
            <p className="ld-panel__meta">页面显示前 100 条；全部差异已保存在本机对账记录中。</p>
          )}
        </div>
      )}
    </section>
  );
}
