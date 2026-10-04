import { useCallback, useEffect, useRef, useState } from "react";
import { Button, cn, MoneyText } from "@laundry/ui";
import type { ChannelIntent, ChannelRefund } from "@laundry/contracts";
import type { ChannelResult, PaymentChannelPort } from "../host/payment-channel-port.js";
import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort } from "../commands/types.js";
import { channelStateLabels } from "./payment-channel-model.js";
import { PaymentChannelIntentDetail } from "./PaymentChannelIntentDetail.js";

/**
 * ADR-85 r1: administrator view of recent collections and refunds. Collection itself
 * starts at pickup; here an administrator queries, closes, writes off or refunds.
 */
export function PaymentChannelCollection({
  port,
  authClient,
  commandClient,
  session,
}: Readonly<{
  port: PaymentChannelPort;
  authClient: AuthClient;
  commandClient: CommandPort;
  session: SessionView;
}>) {
  const [intents, setIntents] = useState<readonly ChannelIntent[]>([]),
    [refunds, setRefunds] = useState<readonly ChannelRefund[]>([]);
  const [selected, setSelected] = useState<ChannelIntent | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = generation.current;
    setBusy(true);
    setMessage("");
    const [payments, returns] = await Promise.all([port.list(), port.refunds()]);
    if (current !== generation.current) return;
    setBusy(false);
    if (payments.ok) setIntents(payments.data.intents);
    if (returns.ok) setRefunds(returns.data.refunds);
    if (!payments.ok || !returns.ok)
      setMessage(payments.ok ? (returns.ok ? "" : returns.error) : payments.error);
  }, [port]);

  useEffect(() => {
    ++generation.current;
    void load();
    return () => {
      ++generation.current;
    };
  }, [load]);

  const run = async (action: () => Promise<ChannelResult<ChannelIntent>>) => {
    if (busy) return false;
    const current = generation.current;
    setBusy(true);
    setMessage("");
    const result = await action();
    if (current !== generation.current) return false;
    setBusy(false);
    if (!result.ok) {
      setMessage(result.error);
      return false;
    }
    setSelected(result.data);
    setIntents((old) => [
      result.data,
      ...old.filter((row) => row.intent_id !== result.data.intent_id),
    ]);
    return true;
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
    <section className="ld-panel" aria-label="渠道收款与退款">
      <div className="ld-panel__row">
        <p className="ld-panel__lead">
          以“渠道已确认收款”为准。结果待确认的收款系统会自动查询；过期后仍无结果，可在核对商户后台后人工核销。
        </p>
        <Button variant="secondary" disabled={busy} onClick={() => void load()}>
          刷新最近收退款记录
        </Button>
      </div>
      {message ? (
        <p className="ld-panel__note ld-panel__note--warn" role="status">
          {message}
        </p>
      ) : null}
      {selected ? (
        <PaymentChannelIntentDetail
          intent={selected}
          port={port}
          busy={busy}
          authClient={authClient}
          commandClient={commandClient}
          session={session}
          run={run}
          onRefunded={() => void load()}
        />
      ) : null}
      <h3>最近收款</h3>
      {intents.length === 0 ? <p className="ld-panel__meta">暂无扫码收款记录。</p> : null}
      <ul aria-label="最近收款记录" className="ld-panel__list">
        {intents.map((intent) => (
          <li
            key={intent.intent_id}
            className={cn(
              "ld-panel__item",
              selected?.intent_id === intent.intent_id && "is-selected",
            )}
          >
            <span>
              {intent.purpose === "topup" ? "会员充值" : "订单"} ·{" "}
              {intent.channel === "wechat" ? "微信" : "支付宝"} ·{" "}
              <MoneyText fen={intent.amount_cents} /> · {channelStateLabels[intent.state]}
              <span className="ld-panel__meta">
                {" "}
                · {new Date(intent.created_at).toLocaleString()}
              </span>
            </span>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setSelected(intent)}>
              查看
            </Button>
          </li>
        ))}
      </ul>
      <h3>最近退款</h3>
      {refunds.length === 0 ? <p className="ld-panel__meta">暂无原路退款记录。</p> : null}
      <ul aria-label="最近退款记录" className="ld-panel__list">
        {refunds.map((refund) => (
          <li key={refund.refund_id} className="ld-panel__item">
            <span>
              <MoneyText fen={refund.amount_cents} /> · {channelStateLabels[refund.state]}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void updateRefund(refund)}
            >
              查询退款结果
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
