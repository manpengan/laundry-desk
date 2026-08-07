import { useCallback, useEffect, useState } from "react";

import { Button, Dialog, EmptyState, Input, MoneyText } from "@laundry/ui";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type {
  CommandPort,
  CommandResult,
  MemberTopupConfirmationSummary,
  QueryPort,
} from "../commands/types.js";

import { unwrapQueryResult, type CustomerRowView } from "./customer-model.js";
import {
  parseMemberAccountView,
  topupAmountToCents,
  type MemberAccountView,
  type MemberLedgerKindView,
  type MemberTenderView,
} from "./member-model.js";
import { MemberRefundForm } from "./MemberRefundForm.js";
import { MemberLifecyclePanel } from "./MemberLifecyclePanel.js";
import { MEMBER_TOPUP_METHODS, MemberTopupConfirmation } from "./MemberTopupConfirmation.js";

export type MemberBalancePanelProps = Readonly<{
  customer: CustomerRowView;
  queryClient: QueryPort;
  commandClient: CommandPort;
  authClient?: AuthClient;
  session?: SessionView;
  toast: Readonly<{ push: (message: string, kind: "success" | "error") => void }>;
}>;

function ledgerLabel(kind: MemberLedgerKindView): string {
  if (kind === "topup") return "充值";
  if (kind === "pay") return "消费";
  if (kind === "refund") return "退款";
  if (kind === "bonus_forfeit") return "赠款销户作废";
  return "冲正";
}

export type MemberTopupBody = Readonly<{
  account_id: string;
  amount_cents: number;
  method: MemberTenderView;
}>;

type PendingTopup = Readonly<{
  confirmRef: string;
  method: MemberTenderView;
  summary: MemberTopupConfirmationSummary;
}>;

export function requestMemberTopup(
  commandClient: CommandPort,
  body: MemberTopupBody,
): Promise<CommandResult> {
  return commandClient.execute("member.topup", body);
}

/** Resume the R3 top-up with only the server-frozen confirmation reference. */
export function resumeMemberTopup(commandClient: CommandPort, confirmRef: string) {
  return commandClient.execute("member.topup", {}, { confirmRef });
}

export function MemberBalancePanel({
  customer,
  queryClient,
  commandClient,
  authClient,
  session,
  toast,
}: MemberBalancePanelProps) {
  const [view, setView] = useState<MemberAccountView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<MemberTenderView>("cash");
  const [pendingTopup, setPendingTopup] = useState<PendingTopup | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const result = await queryClient.execute<unknown>("member.account.get", {
        customer_id: customer.customer_id,
      });
      if (!result.ok) {
        toast.push(result.error.message ?? result.error.code, "error");
        // Surface the failure instead of leaving the panel on its loading text
        // forever — a stuck spinner reads as "no balance", which is worse than
        // an explicit error next to money.
        setFailed(true);
        return;
      }
      setView(parseMemberAccountView(unwrapQueryResult(result.data), customer.customer_id));
      setFailed(false);
      setLoaded(true);
    } finally {
      setBusy(false);
    }
  }, [customer.customer_id, queryClient, toast]);

  useEffect(() => {
    setView(null);
    setLoaded(false);
    setFailed(false);
    void load();
  }, [load]);

  const openAccount = useCallback(async () => {
    setBusy(true);
    try {
      const result = await commandClient.execute<unknown>("member.account.open", {
        customer_id: customer.customer_id,
      });
      if (!result.ok) {
        toast.push(result.error.message ?? result.error.code, "error");
        return;
      }
      toast.push("会员账户已开通", "success");
      await load();
    } finally {
      setBusy(false);
    }
  }, [commandClient, customer.customer_id, load, toast]);

  const topup = useCallback(async () => {
    const cents = topupAmountToCents(amount);
    if (cents === null) {
      toast.push("请输入大于 0 的充值金额，最多两位小数", "error");
      return;
    }
    if (view?.account === null || view === null) return;
    setBusy(true);
    try {
      const body: MemberTopupBody = Object.freeze({
        account_id: view.account.account_id,
        amount_cents: cents,
        method,
      });
      const result = await requestMemberTopup(commandClient, body);
      if (!result.ok) {
        if (isStepUpRequired(result) && result.error.code === "POLICY_CONFIRMATION_REQUIRED") {
          const summary = result.error.detail.summary;
          if (summary?.kind !== "member_topup" || summary.principal_cents !== cents) {
            toast.push("服务器未返回可核对的赠款金额，请重试", "error");
            return;
          }
          setPendingTopup(
            Object.freeze({
              confirmRef: result.error.detail.confirm_ref,
              method: body.method,
              summary,
            }),
          );
          return;
        }
        toast.push(result.error.message ?? result.error.code, "error");
        return;
      }
      toast.push("充值已入账", "success");
      setAmount("");
      await load();
    } finally {
      setBusy(false);
    }
  }, [amount, commandClient, load, method, toast, view]);

  const confirmTopup = useCallback(async () => {
    if (pendingTopup === null) return;
    setBusy(true);
    try {
      const result = await resumeMemberTopup(commandClient, pendingTopup.confirmRef);
      if (!result.ok) {
        setPendingTopup(null);
        toast.push(result.error.message ?? result.error.code, "error");
        await load();
        return;
      }
      setPendingTopup(null);
      toast.push("充值已入账", "success");
      setAmount("");
      await load();
    } finally {
      setBusy(false);
    }
  }, [commandClient, load, pendingTopup, toast]);

  if (failed) {
    return (
      <section className="ld-member-panel" aria-label="会员储值">
        <h3 className="ld-member-panel__title">会员储值</h3>
        <p className="ld-member-panel__hint">储值信息读取失败。</p>
        <Button onClick={() => void load()} disabled={busy}>
          重试
        </Button>
      </section>
    );
  }

  if (!loaded) {
    return (
      <section className="ld-member-panel" aria-label="会员储值">
        <h3 className="ld-member-panel__title">会员储值</h3>
        <p className="ld-member-panel__hint">读取中…</p>
      </section>
    );
  }

  if (view === null) {
    return (
      <section className="ld-member-panel" aria-label="会员储值">
        <h3 className="ld-member-panel__title">会员储值</h3>
        <p className="ld-member-panel__hint">储值信息无法解析，请重试或联系管理员。</p>
        <Button onClick={() => void load()} disabled={busy}>
          重试
        </Button>
      </section>
    );
  }

  if (view.account === null) {
    return (
      <section className="ld-member-panel" aria-label="会员储值">
        <h3 className="ld-member-panel__title">会员储值</h3>
        <EmptyState title="尚未开通会员" description="开通后可预存金额，并用余额结账。" />
        <Button onClick={() => void openAccount()} disabled={busy}>
          开通会员账户
        </Button>
      </section>
    );
  }

  const account = view.account;

  return (
    <section className="ld-member-panel" aria-label="会员储值">
      <div className="ld-member-panel__heading">
        <h3 className="ld-member-panel__title">会员储值</h3>
        <span
          className={`ld-member-panel__status ld-member-panel__status--${account.status}`}
          data-testid="member-status"
        >
          {account.status === "active"
            ? "正常"
            : account.status === "frozen"
              ? "挂失冻结"
              : "已销户"}
        </span>
      </div>

      <p className="ld-member-panel__balance">
        <span className="ld-member-panel__balance-label">
          {account.status === "active" ? "可用余额" : "账户余额"}
        </span>
        <MoneyText fen={account.balance_cents} size="lg" />
      </p>
      {account.bonus_cents > 0 ? (
        <p className="ld-member-panel__split">
          本金 <MoneyText fen={account.principal_cents} /> ／ 赠款{" "}
          <MoneyText fen={account.bonus_cents} />
        </p>
      ) : null}
      {account.status === "frozen" ? (
        <p className="ld-member-panel__hint" role="status">
          账户已挂失冻结，暂不可充值、余额消费或普通退款。
          {account.status_reason === null ? null : ` 原因：${account.status_reason}`}
        </p>
      ) : account.status === "closed" ? (
        <p className="ld-member-panel__hint" role="status">
          账户已退卡销户，余额与资金操作永久关闭，不能重新开通。
          {account.status_reason === null ? null : ` 原因：${account.status_reason}`}
        </p>
      ) : null}

      {account.status === "active" ? (
        <div className="ld-member-panel__topup">
          <Input
            label="充值金额（元）"
            value={amount}
            inputMode="decimal"
            onChange={(event) => setAmount(event.target.value)}
            disabled={busy}
          />
          <label className="ld-member-panel__method">
            <span>收款方式</span>
            <select
              value={method}
              onChange={(event) => setMethod(event.target.value as MemberTenderView)}
              disabled={busy}
            >
              {MEMBER_TOPUP_METHODS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <Button onClick={() => void topup()} disabled={busy}>
            充值
          </Button>
        </div>
      ) : null}

      <MemberRefundForm
        accountId={account.account_id}
        accountStatus={account.status}
        refundableCents={account.principal_cents}
        commandClient={commandClient}
        {...(authClient === undefined ? {} : { authClient })}
        {...(session === undefined ? {} : { session })}
        toast={toast}
        onCompleted={load}
      />

      <MemberLifecyclePanel
        customer={customer}
        account={account}
        commandClient={commandClient}
        {...(authClient === undefined ? {} : { authClient })}
        {...(session === undefined ? {} : { session })}
        toast={toast}
        onCompleted={load}
      />

      <ul className="ld-member-panel__ledger">
        {view.recent.length === 0 ? (
          <li className="ld-member-panel__hint">暂无储值流水</li>
        ) : (
          view.recent.map((row) => (
            <li key={row.ledger_id} className="ld-member-panel__row">
              <span>{ledgerLabel(row.kind)}</span>
              <MoneyText fen={row.principal_delta_cents + row.bonus_delta_cents} />
              <span className="ld-member-panel__date">{row.business_date}</span>
            </li>
          ))
        )}
      </ul>

      <Dialog
        open={pendingTopup !== null}
        title="确认会员充值"
        onClose={() => {
          if (!busy) setPendingTopup(null);
        }}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingTopup(null)} disabled={busy}>
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => void confirmTopup()}
              disabled={busy}
              data-testid="member-topup-confirm"
            >
              {busy ? "充值中…" : "确认充值"}
            </Button>
          </>
        }
      >
        {pendingTopup === null ? null : (
          <MemberTopupConfirmation method={pendingTopup.method} summary={pendingTopup.summary} />
        )}
      </Dialog>
    </section>
  );
}
