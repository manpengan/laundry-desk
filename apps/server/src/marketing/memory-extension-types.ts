import type {
  MarketingGroupBuyRedemption,
  MarketingGroupBuyVoucher,
  MarketingReferralReward,
  MarketingReferralRewardAuthority,
} from "@laundry/contracts";

import type { MemberBenefitsStore } from "../member-benefits/types.js";
import type { MemberStore } from "../member/types.js";
import type { OrderStore } from "../order/types.js";
import type { MarketingCampaignRecord, MemoryAudienceCustomer } from "./types.js";

export type MemoryVoucherRecord = Readonly<{
  public: MarketingGroupBuyVoucher;
  digest: string;
  reason: string;
}>;

export type MemoryRewardRecord = Readonly<{
  public: MarketingReferralReward;
  authority: MarketingReferralRewardAuthority;
  reason: string;
}>;

export type MemoryRedemptionRecord = Readonly<{
  public: MarketingGroupBuyRedemption;
  orderOriginalCents: number;
  orderPayableBeforeCents: number;
  reason: string;
}>;

export type MarketingExtensionMemoryAccess = Readonly<{
  newId: () => string;
  customers: readonly MemoryAudienceCustomer[];
  memberStore?: MemberStore;
  memberBenefits?: MemberBenefitsStore;
  orderStore?: OrderStore;
  getCampaign: (id: string) => MarketingCampaignRecord | undefined;
  commitBudget: (campaignId: string, amountCents: number) => void;
}>;
