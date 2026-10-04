import { useState } from "react";
import { Button, Input, MoneyText } from "@laundry/ui";
import { ChannelResolveInputSchema, type ChannelIntent } from "@laundry/contracts";
import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort } from "../commands/types.js";
import type { ChannelResult, PaymentChannelPort } from "../host/payment-channel-port.js";
import { channelErrorText, channelStateLabels } from "./payment-channel-model.js";
import { PaymentChannelRefund } from "./PaymentChannelRefund.js";
import { PaymentQr } from "./PaymentQr.js";

/** Mirrors the server's expiry grace (ADR-85 r1): only then can no provider answer still arrive. */
const RESOLVE_GRACE_MS = 2 * 60_000;
const CLOSABLE = ["created", "pending", "unknown"];
const NOT_RESOLVABLE =
  "这笔收款现在不能人工核销：渠道可能已有交易记录，或仍在过期等待期内。请先点“查询渠道最新结果”。";

export function resolvable(intent: ChannelIntent, now = Date.now()): boolean {
  return (
    ["unknown", "needs_review"].includes(intent.state) &&
    Date.parse(intent.expires_at) + RESOLVE_GRACE_MS <= now
  );
}

export type IntentDetailProps = Readonly<{
  intent: ChannelIntent;
  port: PaymentChannelPort;
  busy: boolean;
  authClient: AuthClient;
  commandClient: CommandPort;
  session: SessionView;
  /** Runs one port call under the panel's busy state and applies the returned intent. */
  run: (action: () => Promise<ChannelResult<ChannelIntent>>) => Promise<boolean>;
  onRefunded: () => void;
}>;

export function PaymentChannelIntentDetail(props: IntentDetailProps) {
  const { intent, port, busy, run } = props;
  const note = channelErrorText(intent.error_code);
  return (
    <div className="ld-panel__sub" aria-label="收款详情">
      <p className="ld-channel-collect__state" role="status">
        {intent.channel === "wechat" ? "微信" : "支付宝"} <MoneyText fen={intent.amount_cents} /> ·{" "}
        {channelStateLabels[intent.state]}
        <span className="ld-panel__meta"> · {new Date(intent.created_at).toLocaleString()}</span>
      </p>
      {note ? <p className="ld-panel__note ld-panel__note--warn">{note}</p> : null}
      <PaymentQr intent={intent} />
      <div className="ld-panel__actions">
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void run(() => port.status(intent.intent_id))}
        >
          查询渠道最新结果
        </Button>
        {CLOSABLE.includes(intent.state) ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void run(() => port.close(intent.intent_id))}
          >
            关闭未支付订单
          </Button>
        ) : null}
      </div>
      {resolvable(intent) ? <ResolveForm key={intent.intent_id} {...props} /> : null}
      {intent.state === "paid" ? (
        <PaymentChannelRefund
          key={intent.intent_id}
          intent={intent}
          authClient={props.authClient}
          commandClient={props.commandClient}
          session={props.session}
          onSubmitted={props.onRefunded}
        />
      ) : null}
    </div>
  );
}

function ResolveForm({ intent, port, busy, run }: IntentDetailProps) {
  const [note, setNote] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const submit = async () => {
    const parsed = ChannelResolveInputSchema.safeParse({
      intent_id: intent.intent_id,
      note,
      password,
    });
    if (!parsed.success) {
      setError("请写明核对依据（至少 4 个字），并输入当前管理员密码。");
      return;
    }
    setError("");
    setPassword("");
    const done = await run(async () => {
      const result = await port.resolve(parsed.data);
      return result.ok || result.code !== "RESOURCE_UNAVAILABLE"
        ? result
        : { ok: false, error: NOT_RESOLVABLE };
    });
    if (done) setNote("");
  };
  return (
    <div className="ld-panel" aria-label="人工核销">
      <h4>人工核销</h4>
      <p className="ld-panel__lead">
        长时间查不到结果时使用。请先在微信支付或支付宝商户后台确认这笔<strong>没有收到钱</strong>
        ，核销后订单解锁，可改收现金。核销记录和依据会写入审计。
      </p>
      <div className="ld-panel__grid">
        <Input
          name="channel-resolve-note"
          label="核对依据"
          placeholder="例如：已在商户后台查询，无此笔交易"
          maxLength={200}
          value={note}
          disabled={busy}
          onChange={(event) => setNote(event.target.value)}
        />
        <Input
          name="channel-resolve-password"
          label="当前管理员密码"
          type="password"
          autoComplete="current-password"
          maxLength={256}
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      {error ? <p className="ld-field-error">{error}</p> : null}
      <div className="ld-panel__actions">
        <Button variant="danger" disabled={busy || !password} onClick={() => void submit()}>
          确认未收款并核销
        </Button>
      </div>
    </div>
  );
}
