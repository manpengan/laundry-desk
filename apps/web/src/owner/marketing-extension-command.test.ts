import assert from "node:assert/strict";
import test from "node:test";

import type {
  MarketingGroupBuyVoucherRedeemInput,
  MarketingGroupBuyVoucherRegisterInput,
  MarketingReferralRewardIssueInput,
} from "@laundry/contracts";

import type { SessionView } from "../auth/types.js";
import {
  bindMarketingExtensionAuthority,
  createMarketingExtensionAttempt,
  marketingExtensionAttemptMatches,
  marketingExtensionEpochMatches,
  marketingExtensionScopeKey,
  marketingGroupBuyRedemptionAuthorityKey,
  marketingGroupBuyRegistrationAuthorityKey,
  marketingReferralAuthorityKey,
} from "./marketing-extension-command.js";

type Deferred<T> = Readonly<{ promise: Promise<T>; resolve: (value: T) => void }>;

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  if (resolve === undefined) throw new Error("deferred resolver unavailable");
  return Object.freeze({ promise, resolve });
}

function session(staffId: string, version: number): SessionView {
  return Object.freeze({
    session: Object.freeze({
      session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      session_version: version,
      org_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      store_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      staff_id: staffId,
      device_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      permission_version: version,
    }),
    role: "admin",
    features: Object.freeze({ marketing_enabled: true }),
    display: Object.freeze({
      store_name: "主店",
      staff_name: "店主",
      org_code: "ORG",
      store_code: "S1",
    }),
  });
}

const referralInput: MarketingReferralRewardIssueInput = Object.freeze({
  campaign_id: "11111111-1111-4111-8111-111111111111",
  expected_version: 3,
  referrer_customer_id: "22222222-2222-4222-8222-222222222222",
  referred_customer_id: "33333333-3333-4333-8333-333333333333",
  qualifying_order_id: "44444444-4444-4444-8444-444444444444",
  coupon_definition_id: "55555555-5555-4555-8555-555555555555",
  reason: "首单推荐",
});
const registerInput: MarketingGroupBuyVoucherRegisterInput = Object.freeze({
  provider: "meituan",
  external_order_ref: "mt-1",
  voucher_code_digest: "a".repeat(64),
  voucher_code_last4: "2345",
  label: "团购精洗券",
  face_value_cents: 3_000,
  expires_at: "2026-09-01T00:00:00.000Z",
  reason: "平台售出",
});
const redeemInput: MarketingGroupBuyVoucherRedeemInput = Object.freeze({
  voucher_code_digest: "b".repeat(64),
  order_id: "66666666-6666-4666-8666-666666666666",
  reason: "前台核销",
});

test("campaign A response cannot install a referral card after campaign B is selected", async () => {
  const currentSession = session("77777777-7777-4777-8777-777777777777", 1);
  const scopeA = marketingExtensionScopeKey(currentSession, JSON.stringify(["campaign-a", 3]));
  const scopeB = marketingExtensionScopeKey(currentSession, JSON.stringify(["campaign-b", 1]));
  const attempt = createMarketingExtensionAttempt(4, scopeA, "marketing.referral.reward.issue");
  const epoch = bindMarketingExtensionAuthority(
    attempt,
    marketingReferralAuthorityKey(scopeA, referralInput),
  );
  const response = deferred<"pending">();
  let installed = 0;
  const handled = response.promise.then(() => {
    if (
      marketingExtensionEpochMatches(
        epoch,
        4,
        scopeB,
        "marketing.referral.reward.issue",
        marketingReferralAuthorityKey(scopeB, {
          ...referralInput,
          campaign_id: "88888888-8888-4888-8888-888888888888",
          expected_version: 1,
        }),
      )
    ) {
      installed += 1;
    }
  });

  response.resolve("pending");
  await handled;
  assert.equal(installed, 0);
});

test("input changes and a second click supersede a deferred group-buy hash", async () => {
  const scope = marketingExtensionScopeKey(
    session("77777777-7777-4777-8777-777777777777", 1),
    "group-buy",
  );
  const firstHash = deferred<MarketingGroupBuyVoucherRegisterInput>();
  const first = createMarketingExtensionAttempt(10, scope, "marketing.group_buy.voucher.register");
  const second = createMarketingExtensionAttempt(11, scope, "marketing.group_buy.voucher.register");
  let commandCalls = 0;
  const firstHandled = firstHash.promise.then((input) => {
    if (
      marketingExtensionAttemptMatches(
        first,
        second.generation,
        scope,
        "marketing.group_buy.voucher.register",
      )
    ) {
      marketingGroupBuyRegistrationAuthorityKey(scope, input);
      commandCalls += 1;
    }
  });
  firstHash.resolve(registerInput);
  await firstHandled;
  assert.equal(commandCalls, 0, "the first of two rapid clicks must not reach the command port");

  const changedInputHash = deferred<MarketingGroupBuyVoucherRedeemInput>();
  const beforeEdit = createMarketingExtensionAttempt(
    20,
    scope,
    "marketing.group_buy.voucher.redeem",
  );
  const edited = changedInputHash.promise.then((input) => {
    if (marketingExtensionAttemptMatches(beforeEdit, 21, scope, null)) {
      marketingGroupBuyRedemptionAuthorityKey(scope, input);
      commandCalls += 1;
    }
  });
  changedInputHash.resolve(redeemInput);
  await edited;
  assert.equal(commandCalls, 0, "editing during hashing must invalidate the pending attempt");
});

test("quick-switch makes a deferred response unable to install, apply, or toast", async () => {
  const staffA = session("77777777-7777-4777-8777-777777777777", 1);
  const staffB = session("88888888-8888-4888-8888-888888888888", 2);
  const scopeA = marketingExtensionScopeKey(staffA, "group-buy");
  const scopeB = marketingExtensionScopeKey(staffB, "group-buy");
  const attempt = createMarketingExtensionAttempt(30, scopeA, "marketing.group_buy.voucher.redeem");
  const epoch = bindMarketingExtensionAuthority(
    attempt,
    marketingGroupBuyRedemptionAuthorityKey(scopeA, redeemInput),
  );
  const response = deferred<"success">();
  const effects = { installed: 0, applied: 0, toasted: 0 };
  const handled = response.promise.then(() => {
    if (
      !marketingExtensionEpochMatches(
        epoch,
        30,
        scopeB,
        "marketing.group_buy.voucher.redeem",
        marketingGroupBuyRedemptionAuthorityKey(scopeB, redeemInput),
      )
    ) {
      return;
    }
    effects.installed += 1;
    effects.applied += 1;
    effects.toasted += 1;
  });

  response.resolve("success");
  await handled;
  assert.deepEqual(effects, { installed: 0, applied: 0, toasted: 0 });
});

test("group-buy authority keys bind action, session and digest", () => {
  const scope = marketingExtensionScopeKey(
    session("77777777-7777-4777-8777-777777777777", 1),
    "group-buy",
  );
  const registration = marketingGroupBuyRegistrationAuthorityKey(scope, registerInput);
  const changedDigest = marketingGroupBuyRegistrationAuthorityKey(scope, {
    ...registerInput,
    voucher_code_digest: "c".repeat(64),
  });
  const redemption = marketingGroupBuyRedemptionAuthorityKey(scope, redeemInput);
  assert.notEqual(registration, changedDigest);
  assert.notEqual(registration, redemption);
  assert.ok(registration.includes(registerInput.voucher_code_digest));
});
