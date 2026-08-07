import { MoneyText } from "@laundry/ui";

import type { MemberTopupConfirmationSummary } from "../commands/types.js";
import type { MemberTenderView } from "./member-model.js";

export const MEMBER_TOPUP_METHODS = Object.freeze([
  { value: "cash", label: "现金" },
  { value: "wechat", label: "微信" },
  { value: "alipay", label: "支付宝" },
  { value: "other", label: "其他" },
] as const);

function topupMethodLabel(method: MemberTenderView): string {
  return MEMBER_TOPUP_METHODS.find((item) => item.value === method)?.label ?? "其他";
}

export function MemberTopupConfirmation({
  method,
  summary,
}: Readonly<{
  method: MemberTenderView;
  summary: MemberTopupConfirmationSummary;
}>) {
  return (
    <div className="ld-member-confirmation" data-testid="member-topup-summary">
      <p>
        充值本金 <MoneyText fen={summary.principal_cents} />
      </p>
      <p>
        赠送 <MoneyText fen={summary.bonus_cents} />
      </p>
      <p>
        到账 <MoneyText fen={summary.credited_cents} />
      </p>
      <p>收款渠道：{topupMethodLabel(method)}</p>
      <p>
        {summary.matched_rule === null ? (
          "未命中赠送档位，本次赠款为 0。"
        ) : (
          <>
            命中档位：充满 <MoneyText fen={summary.matched_rule.min_topup_cents} /> 送{" "}
            <MoneyText fen={summary.matched_rule.bonus_cents} />
          </>
        )}
      </p>
    </div>
  );
}
