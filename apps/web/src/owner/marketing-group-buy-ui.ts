import type {
  MarketingGroupBuyRedemptionConfirmationSummary,
  MarketingGroupBuyRegistrationConfirmationSummary,
} from "@laundry/contracts";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort } from "../commands/types.js";

export type GroupBuyPending =
  | Readonly<{
      action: "marketing.group_buy.voucher.register";
      ref: string;
      summary: MarketingGroupBuyRegistrationConfirmationSummary;
    }>
  | Readonly<{
      action: "marketing.group_buy.voucher.redeem";
      ref: string;
      summary: MarketingGroupBuyRedemptionConfirmationSummary;
    }>;

export type OwnerMarketingGroupBuyProps = Readonly<{
  session: SessionView;
  authClient: AuthClient;
  commandClient: CommandPort;
}>;

export function yuanToCents(value: string): number | null {
  if (!/^(?:0|[1-9]\d{0,4})(?:\.\d{1,2})?$/u.test(value.trim())) return null;
  const [yuan = "0", fraction = ""] = value.trim().split(".");
  const cents = Number(yuan) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}
