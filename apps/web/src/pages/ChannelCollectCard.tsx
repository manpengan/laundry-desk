import { useCallback, useEffect, useRef, useState } from "react";
import { Button, MoneyText, useToast } from "@laundry/ui";
import type { ChannelIntent } from "@laundry/contracts";
import type { ChannelResult, PaymentChannelPort } from "../host/payment-channel-port.js";
import {
  channelErrorText,
  channelStateLabels,
  OPEN_CHANNEL_STATES,
} from "./payment-channel-model.js";
import { PaymentQr } from "./PaymentQr.js";

type Channel = "wechat" | "alipay";
const CHANNEL_NAMES: Readonly<Record<Channel, string>> = Object.freeze({
  wechat: "微信",
  alipay: "支付宝",
});
const POLL_MS = 3_000;
const isOpen = (intent: ChannelIntent | null) =>
  intent !== null && OPEN_CHANNEL_STATES.includes(intent.state);

export type ChannelCollectCardProps = Readonly<{
  port: PaymentChannelPort;
  order: Readonly<{ order_id: string; status: string; balance_cents: number }>;
  /** Bumped by the page when a command reports an unfinished collection. */
  refreshKey: number;
  disabled: boolean;
  onPaid: () => void;
}>;

/** Shown only while an open order still owes money. */
export function ChannelCollectCard(props: ChannelCollectCardProps) {
  const { order } = props;
  if (order.status !== "open" || order.balance_cents <= 0) return null;
  return (
    <ChannelCollection
      {...props}
      key={order.order_id}
      orderId={order.order_id}
      balanceCents={order.balance_cents}
    />
  );
}

/**
 * ADR-85 r1: provider QR collection lives where the money is taken. Staff see an
 * unfinished collection that holds the order and can query or close it themselves.
 */
function ChannelCollection({
  port,
  orderId,
  balanceCents,
  refreshKey,
  disabled,
  onPaid,
}: ChannelCollectCardProps & Readonly<{ orderId: string; balanceCents: number }>) {
  const toast = useToast();
  const [channels, setChannels] = useState<readonly Channel[]>([]);
  const [intent, setIntent] = useState<ChannelIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const attempt = useRef<Readonly<{ channel: Channel; key: string }> | null>(null);

  /** A lost checkout answer may still have created an intent; show it if it is open. */
  const showOpen = useCallback(async () => {
    const current = generation.current;
    const listed = await port.list({ order_id: orderId });
    if (current !== generation.current || !listed.ok) return;
    const open = listed.data.intents.find((row) => isOpen(row));
    if (open !== undefined) setIntent(open);
  }, [orderId, port]);

  useEffect(() => {
    const current = ++generation.current;
    setIntent(null);
    setMessage("");
    void port.available().then((available) => {
      if (current !== generation.current) return;
      setChannels(
        available.ok
          ? available.data.channels.filter((row) => row.enabled).map((row) => row.channel)
          : [],
      );
    });
    void showOpen();
    return () => {
      generation.current++;
    };
  }, [port, refreshKey, showOpen]);

  const apply = useCallback(
    (result: ChannelResult<ChannelIntent>, quiet = false) => {
      if (!result.ok) {
        if (!quiet) setMessage(result.error);
        return;
      }
      const next = result.data;
      setIntent(next);
      setMessage(next.state === "closed" ? (channelErrorText(next.error_code) ?? "") : "");
      if (next.state !== "unknown") attempt.current = null;
      if (next.state === "paid") {
        toast.push(`已收到${CHANNEL_NAMES[next.channel]}付款`, "success");
        onPaid();
      }
    },
    [onPaid, toast],
  );

  const run = useCallback(
    async (action: () => Promise<ChannelResult<ChannelIntent>>, quiet = false) => {
      const current = generation.current;
      if (!quiet) setBusy(true);
      try {
        const result = await action();
        if (current === generation.current) apply(result, quiet);
        return result.ok;
      } finally {
        if (!quiet && current === generation.current) setBusy(false);
      }
    },
    [apply],
  );

  const intentId = intent?.intent_id ?? null;
  const waiting = intent !== null && ["created", "pending", "unknown"].includes(intent.state);
  useEffect(() => {
    if (!waiting || intentId === null) return;
    const timer = setInterval(() => void run(() => port.status(intentId), true), POLL_MS);
    return () => clearInterval(timer);
  }, [intentId, port, run, waiting]);

  const start = (channel: Channel) => {
    // An unconfirmed earlier attempt for the same channel is resent with its key.
    const prior = attempt.current?.channel === channel ? attempt.current : null;
    const key = prior?.key ?? crypto.randomUUID();
    attempt.current = { channel, key };
    void run(() => port.checkout({ order_id: orderId, channel, idempotency_key: key })).then(
      (ok) => {
        if (!ok) void showOpen();
      },
    );
  };

  if (channels.length === 0 && !isOpen(intent)) return null;
  const note = message || (isOpen(intent) ? channelErrorText(intent?.error_code ?? null) : null);
  return (
    <section className="ld-channel-collect" aria-label="扫码收款">
      <div className="ld-channel-collect__head">
        <h3 className="ld-counter-panel__subtitle">扫码收款</h3>
        <span className="ld-channel-collect__due">
          应收 <MoneyText fen={balanceCents} />
        </span>
      </div>
      {intent !== null && isOpen(intent) ? (
        <div className="ld-channel-collect__intent">
          <p className="ld-channel-collect__state" role="status">
            {CHANNEL_NAMES[intent.channel]} <MoneyText fen={intent.amount_cents} /> ·{" "}
            {channelStateLabels[intent.state]}
          </p>
          <PaymentQr intent={intent} />
          <div className="ld-channel-collect__actions">
            <Button
              variant="secondary"
              disabled={disabled || busy}
              onClick={() => void run(() => port.status(intent.intent_id))}
            >
              查询结果
            </Button>
            {intent.state === "needs_review" ? null : (
              <Button
                variant="ghost"
                disabled={disabled || busy}
                onClick={() => void run(() => port.close(intent.intent_id))}
              >
                关闭收款，改收现金
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="ld-channel-collect__actions">
          {channels.map((channel) => (
            <Button
              key={channel}
              variant="secondary"
              disabled={disabled || busy}
              onClick={() => start(channel)}
            >
              {CHANNEL_NAMES[channel]}收款码
            </Button>
          ))}
        </div>
      )}
      {note ? (
        <p className="ld-channel-collect__note" role="alert">
          {note}
        </p>
      ) : null}
    </section>
  );
}
