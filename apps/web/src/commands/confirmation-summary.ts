import {
  FactoryHandoffConfirmationSummarySchema,
  FulfillmentOperationConfirmationSummarySchema,
  MarketingAudienceFreezeConfirmationSummarySchema,
  MarketingCampaignSetConfirmationSummarySchema,
  MarketingCouponIssueConfirmationSummarySchema,
  MarketingCouponReversalConfirmationSummarySchema,
  MarketingGroupBuyRedemptionConfirmationSummarySchema,
  MarketingGroupBuyRegistrationConfirmationSummarySchema,
  MarketingReferralRewardConfirmationSummarySchema,
  NotificationDeliveryConfirmationSummarySchema,
} from "@laundry/contracts";

import { readMemberTopupConfirmationSummary } from "./member-topup-confirmation.js";
import type { ConfirmationSummary } from "./types.js";

export function readConfirmationSummary(value: unknown): ConfirmationSummary | null {
  const member = readMemberTopupConfirmationSummary(value);
  if (member !== null) return member;
  const notification = NotificationDeliveryConfirmationSummarySchema.safeParse(value);
  if (notification.success) {
    return Object.freeze({
      ...notification.data,
      ticket_nos: Object.freeze([...notification.data.ticket_nos]),
      garment_statuses: Object.freeze([...notification.data.garment_statuses]),
    });
  }
  const factory = FactoryHandoffConfirmationSummarySchema.safeParse(value);
  if (factory.success) {
    return Object.freeze({
      ...factory.data,
      ticket_nos: Object.freeze([...factory.data.ticket_nos]),
      barcodes: Object.freeze([...factory.data.barcodes]),
      counts: Object.freeze({ ...factory.data.counts }),
    });
  }
  const campaignSet = MarketingCampaignSetConfirmationSummarySchema.safeParse(value);
  if (campaignSet.success) return Object.freeze(campaignSet.data);
  const audienceFreeze = MarketingAudienceFreezeConfirmationSummarySchema.safeParse(value);
  if (audienceFreeze.success) return Object.freeze(audienceFreeze.data);
  const couponIssue = MarketingCouponIssueConfirmationSummarySchema.safeParse(value);
  if (couponIssue.success) return Object.freeze(couponIssue.data);
  const couponReversal = MarketingCouponReversalConfirmationSummarySchema.safeParse(value);
  if (couponReversal.success) return Object.freeze(couponReversal.data);
  const referral = MarketingReferralRewardConfirmationSummarySchema.safeParse(value);
  if (referral.success) return Object.freeze(referral.data);
  const registration = MarketingGroupBuyRegistrationConfirmationSummarySchema.safeParse(value);
  if (registration.success) return Object.freeze(registration.data);
  const redemption = MarketingGroupBuyRedemptionConfirmationSummarySchema.safeParse(value);
  if (redemption.success) return Object.freeze(redemption.data);
  const fulfillment = FulfillmentOperationConfirmationSummarySchema.safeParse(value);
  if (!fulfillment.success) return null;
  return Object.freeze({
    ...fulfillment.data,
    garment_ids: Object.freeze([...fulfillment.data.garment_ids]),
    ticket_nos: Object.freeze([...fulfillment.data.ticket_nos]),
    barcodes: Object.freeze([...fulfillment.data.barcodes]),
  });
}
