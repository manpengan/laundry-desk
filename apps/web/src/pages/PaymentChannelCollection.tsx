import { useEffect, useRef, useState } from "react";
import { MoneyText } from "@laundry/ui";
import type { ChannelIntent, ChannelRefund } from "@laundry/contracts";
import type { PaymentChannelPort } from "../host/payment-channel-port.js";
import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { parseOrderLookupRows, type OrderLookupRowView } from "./OrderLookupCandidates.js";
import { unwrapQueryResult } from "./customer-model.js";
import { channelStateLabels } from "./payment-channel-model.js";
import { PaymentQr } from "./PaymentQr.js";
import { PaymentChannelRefund } from "./PaymentChannelRefund.js";

export function PaymentChannelCollection({
  port,
  queryClient,
  authClient,
  commandClient,
  session,
}: Readonly<{
  port: PaymentChannelPort;
  queryClient?: QueryPort;
  authClient: AuthClient;
  commandClient: CommandPort;
  session: SessionView;
}>) {
  const [search, setSearch] = useState("");
  const [orders, setOrders] = useState<readonly OrderLookupRowView[]>([]),
    [orderId, setOrderId] = useState("");
  const [channel, setChannel] = useState<"wechat" | "alipay">("wechat");
  const [intents, setIntents] = useState<readonly ChannelIntent[]>([]),
    [refunds, setRefunds] = useState<readonly ChannelRefund[]>([]);
  const [selected, setSelected] = useState<ChannelIntent | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const attempt = useRef<Readonly<{
    order_id: string;
    channel: "wechat" | "alipay";
    idempotency_key: string;
    intentId: string | null;
  }> | null>(null);
  const generation = useRef(0),
    alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    ++generation.current;
    return () => {
      alive.current = false;
      ++generation.current;
    };
  }, []);
  const load = async () => {
    if (!alive.current || busy) return;
    const current = generation.current;
    setBusy(true);
    setMessage("");
    const [payments, returns] = await Promise.all([port.list(), port.refunds()]);
    if (current !== generation.current) return;
    setBusy(false);
    if (payments.ok) setIntents(payments.data.intents);
    else setMessage(payments.error);
    if (returns.ok) setRefunds(returns.data.refunds);
    else setMessage(returns.error);
  };
  const lookup = async () => {
    if (!queryClient || busy || !search.trim()) return;
    const current = generation.current;
    setBusy(true);
    setMessage("");
    setOrders([]);
    setOrderId("");
    setSelected(null);
    try {
      const result = await queryClient.execute("order.lookup", { key: search.trim() });
      if (current !== generation.current) return;
      const rows = result.ok ? parseOrderLookupRows(unwrapQueryResult(result.data)) : null;
      if (rows) {
        setOrders(rows);
        setMessage(rows.length ? "请选择本次收款订单。" : "未找到订单。");
      } else setMessage("订单查询未完成，请检查输入或刷新登录状态。");
    } catch {
      if (current === generation.current) setMessage("订单查询失败，请重试。");
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const checkout = async () => {
    if (
      !orderId ||
      busy ||
      !orders.some((row) => row.order_id === orderId && row.balance_cents > 0)
    )
      return;
    const prior = attempt.current;
    if (prior && (prior.order_id !== orderId || prior.channel !== channel)) {
      setMessage("前次收款结果尚未确认，请先刷新记录并核对；未确认前不能重新发起。");
      return;
    }
    const current = generation.current;
    const idempotency_key = prior?.idempotency_key ?? crypto.randomUUID();
    const body = { order_id: orderId, channel, idempotency_key };
    attempt.current = { ...body, intentId: prior?.intentId ?? null };
    setBusy(true);
    setMessage("");
    const result = await port.checkout(body);
    if (current !== generation.current) return;
    setBusy(false);
    if (result.ok) {
      setSelected(result.data);
      setIntents((old) => [
        result.data,
        ...old.filter((item) => item.intent_id !== result.data.intent_id),
      ]);
      attempt.current = ["paid", "closed"].includes(result.data.state)
        ? null
        : { ...body, intentId: result.data.intent_id };
    } else setMessage(result.error + " 再次提交同一订单会核对同一笔请求。");
  };
  const update = async (intent: ChannelIntent, close = false) => {
    if (!alive.current || busy) return;
    const current = generation.current;
    setBusy(true);
    setMessage("");
    const result = await (close ? port.close(intent.intent_id) : port.status(intent.intent_id));
    if (current !== generation.current) return;
    setBusy(false);
    if (result.ok) {
      setSelected(result.data);
      setIntents((old) => [
        result.data,
        ...old.filter((row) => row.intent_id !== result.data.intent_id),
      ]);
      if (
        ["paid", "closed"].includes(result.data.state) &&
        result.data.intent_id === attempt.current?.intentId
      )
        attempt.current = null;
    } else setMessage(result.error);
  };
  const updateRefund = async (refund: ChannelRefund) => {
    if (busy) return;
    const current = generation.current;
    setBusy(true);
    const result = await port.refundStatus(refund.refund_id);
    if (current !== generation.current) return;
    setBusy(false);
    if (result.ok)
      setRefunds((old) =>
        old.map((row) => (row.refund_id === refund.refund_id ? result.data : row)),
      );
    else setMessage(result.error);
  };
  return (
    <section className="space-y-3" aria-label="渠道收款与退款">
      <h3>收款与退款</h3>
      <p>
        金额按订单当前欠款生成。请以“渠道已确认收款”为准；等待或结果未知时先查询，避免重复收费。
      </p>
      <div className="flex flex-wrap gap-2">
        <label>
          票号、取件码或手机号{" "}
          <input
            className="rounded border p-2"
            maxLength={100}
            value={search}
            disabled={busy || !queryClient}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={busy || !queryClient || !search.trim()}
          onClick={() => void lookup()}
          className="rounded border px-3 py-2"
        >
          查找订单
        </button>
      </div>
      {orders.length > 0 && (
        <label className="block">
          收款订单{" "}
          <select
            value={orderId}
            disabled={busy}
            onChange={(e) => {
              setOrderId(e.target.value);
              setSelected(null);
            }}
          >
            <option value="">请选择订单</option>
            {orders.map((row) => (
              <option key={row.order_id} value={row.order_id} disabled={row.balance_cents <= 0}>
                {row.ticket_no ?? "挂单"} · {row.customer_name ?? "散客"} · 欠款{" "}
                {(row.balance_cents / 100).toFixed(2)} 元
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        付款渠道{" "}
        <select
          value={channel}
          disabled={busy}
          onChange={(e) => setChannel(e.target.value === "alipay" ? "alipay" : "wechat")}
        >
          <option value="wechat">微信</option>
          <option value="alipay">支付宝</option>
        </select>
      </label>
      <button
        type="button"
        disabled={busy || !orderId}
        onClick={() => void checkout()}
        className="rounded border px-3 py-2"
      >
        生成收款码
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void load()}
        className="rounded border px-3 py-2"
      >
        刷新最近收退款记录
      </button>
      {message && <p role="status">{message}</p>}
      {selected && (
        <div className="space-y-2 rounded border p-3">
          <p>
            {selected.channel === "wechat" ? "微信" : "支付宝"}{" "}
            <MoneyText fen={selected.amount_cents} /> · {channelStateLabels[selected.state]}
          </p>
          <PaymentQr intent={selected} />
          <button
            type="button"
            disabled={busy}
            onClick={() => void update(selected)}
            className="rounded border px-3 py-2"
          >
            查询渠道最新结果
          </button>
          {["created", "pending", "unknown"].includes(selected.state) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void update(selected, true)}
              className="rounded border px-3 py-2"
            >
              关闭未支付订单
            </button>
          )}
          {selected.state === "paid" && (
            <PaymentChannelRefund
              key={selected.intent_id}
              intent={selected}
              authClient={authClient}
              commandClient={commandClient}
              session={session}
              onSubmitted={() => void load()}
            />
          )}
        </div>
      )}
      <ul aria-label="最近收款记录" className="space-y-2">
        {intents.map((intent) => (
          <li key={intent.intent_id}>
            <button
              type="button"
              disabled={busy}
              onClick={() => setSelected(intent)}
              className="rounded border px-3 py-2"
            >
              {new Date(intent.created_at).toLocaleString()} ·{" "}
              {intent.purpose === "topup" ? "充值" : "订单"} ·{" "}
              <MoneyText fen={intent.amount_cents} /> · {channelStateLabels[intent.state]}
            </button>
          </li>
        ))}
      </ul>
      <ul aria-label="最近退款记录" className="space-y-2">
        {refunds.map((refund) => (
          <li key={refund.refund_id}>
            <MoneyText fen={refund.amount_cents} /> · {channelStateLabels[refund.state]}{" "}
            <button
              type="button"
              disabled={busy}
              onClick={() => void updateRefund(refund)}
              className="rounded border px-3 py-2"
            >
              查询退款结果
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
