import { useCallback, useEffect, useState } from "react";

import { Button, EmptyState, Input, MoneyText } from "@laundry/ui";

import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, CommandResult, QueryPort } from "../commands/types.js";

import { unwrapQueryResult, type CustomerRowView } from "./customer-model.js";
import {
  parseMemberAccountView,
  topupAmountToCents,
  type MemberAccountView,
} from "./member-model.js";

export type MemberBalancePanelProps = Readonly<{
  customer: CustomerRowView;
  queryClient: QueryPort;
  commandClient: CommandPort;
  toast: Readonly<{ push: (message: string, kind: "success" | "error") => void }>;
}>;

const TOPUP_METHODS = Object.freeze([
  { value: "cash", label: "现金" },
  { value: "wechat", label: "微信" },
  { value: "alipay", label: "支付宝" },
  { value: "other", label: "其他" },
] as const);

function ledgerLabel(kind: string): string {
  if (kind === "topup") return "充值";
  if (kind === "pay") return "消费";
  return "冲正";
}

/** Complete the frozen-argument R3 confirmation hop for a member top-up. */
export async function executeMemberTopup(
  commandClient: CommandPort,
  body: Readonly<{ account_id: string; amount_cents: number; method: string }>,
): Promise<CommandResult> {
  const first = await commandClient.execute("member.topup", body);
  if (!isStepUpRequired(first) || first.error.code !== "POLICY_CONFIRMATION_REQUIRED") {
    return first;
  }
  return commandClient.execute("member.topup", {}, { confirmRef: first.error.detail.confirm_ref });
}

export function MemberBalancePanel({
  customer,
  queryClient,
  commandClient,
  toast,
}: MemberBalancePanelProps) {
  const [view, setView] = useState<MemberAccountView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<string>("cash");

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
      setView(parseMemberAccountView(unwrapQueryResult(result.data)));
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
      const result = await executeMemberTopup(commandClient, {
        account_id: view.account.account_id,
        amount_cents: cents,
        method,
      });
      if (!result.ok) {
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
      <h3 className="ld-member-panel__title">会员储值</h3>

      <p className="ld-member-panel__balance">
        <span className="ld-member-panel__balance-label">可用余额</span>
        <MoneyText fen={account.balance_cents} size="lg" />
      </p>
      {account.bonus_cents > 0 ? (
        <p className="ld-member-panel__split">
          本金 <MoneyText fen={account.principal_cents} /> ／ 赠款{" "}
          <MoneyText fen={account.bonus_cents} />
        </p>
      ) : null}
      {account.status !== "active" ? (
        <p className="ld-member-panel__hint">账户已冻结，暂不可充值或消费。</p>
      ) : null}

      <div className="ld-member-panel__topup">
        <Input
          label="充值金额（元）"
          value={amount}
          inputMode="decimal"
          onChange={(event) => setAmount(event.target.value)}
          disabled={busy || account.status !== "active"}
        />
        <label className="ld-member-panel__method">
          <span>收款方式</span>
          <select
            value={method}
            onChange={(event) => setMethod(event.target.value)}
            disabled={busy || account.status !== "active"}
          >
            {TOPUP_METHODS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={() => void topup()} disabled={busy || account.status !== "active"}>
          充值
        </Button>
      </div>

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
    </section>
  );
}
