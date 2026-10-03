import { useEffect, useRef, useState } from "react";
import type { ChannelReconcileInput, ChannelReconciliation } from "@laundry/contracts";
import type { PaymentChannelPort } from "../host/payment-channel-port.js";
import { parseChannelStatement } from "./payment-channel-model.js";
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
  const [input, setInput] = useState<ChannelReconcileInput | null>(null);
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
    setInput(null);
    setResult(null);
    setMessage("");
    if (!file || file.size > 2_000_000) {
      setMessage("请选择不超过 2 MB 的规范 CSV 账单。");
      return;
    }
    try {
      const text = await file.text();
      if (current !== fileGeneration.current || life !== generation.current) return;
      setInput(parseChannelStatement(channel, date, text));
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
    <section className="space-y-3" aria-label="支付账单对账">
      <h3>商户账单核对</h3>
      <p>
        从商户后台导出账单后，整理为下列五列的 UTF-8
        CSV。金额单位为分，类型填“收款”或“退款”；收款的退款号留空。
      </p>
      <p className="select-all break-all">商户订单号,渠道订单号,金额分,类型,商户退款号</p>
      <p>导入只核对本机流水并保存差异，不会自动补收、退款或改账。</p>
      <label>
        渠道{" "}
        <select
          value={channel}
          disabled={busy}
          onChange={(e) => {
            ++fileGeneration.current;
            setChannel(e.target.value === "alipay" ? "alipay" : "wechat");
            setInput(null);
            setResult(null);
          }}
        >
          <option value="wechat">微信</option>
          <option value="alipay">支付宝</option>
        </select>
      </label>
      <label>
        账单日期{" "}
        <input
          type="date"
          value={date}
          disabled={busy}
          onChange={(e) => {
            ++fileGeneration.current;
            setDate(e.target.value);
            setInput(null);
            setResult(null);
          }}
        />
      </label>
      <label className="block">
        选择规范账单{" "}
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={busy || !date}
          onChange={(e) => {
            void readFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </label>
      {input && (
        <p>
          已校验 {input.rows.length} 行，日期 {input.business_date}，待提交核对。
        </p>
      )}
      <button
        type="button"
        disabled={busy || !input}
        onClick={() => void reconcile()}
        className="rounded border px-3 py-2"
      >
        提交对账
      </button>
      {message && <p role="alert">{message}</p>}
      {result && (
        <div>
          <p role="status">
            匹配 {result.matched_count} 笔，差异 {result.mismatches.length} 笔。
          </p>
          <p className="break-all">账单校验值：{result.source_sha256}</p>
          <ul>
            {result.mismatches.slice(0, 100).map((row, index) => (
              <li key={`${row.merchant_order}:${index}`}>
                {row.merchant_order} · {row.merchant_refund ?? "收款"} · {labels[row.reason]}
              </li>
            ))}
          </ul>
          {result.mismatches.length > 100 && (
            <p>页面显示前 100 条；全部差异已保存在本机对账记录中。</p>
          )}
        </div>
      )}
    </section>
  );
}
