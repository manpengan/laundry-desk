import { asRecord, requireInteger, requireThat, requireUuid } from "./adr36-web-core.mjs";
import { orderArgs, stableJson, writeMutation } from "./adr36-web-journey-support.mjs";

async function activeBonusThreshold(api, session) {
  const listed = asRecord(
    await api.query(session, "member.bonus_rules.list", { include_retired: false }),
  );
  requireThat(Array.isArray(listed.rules), "BONUS_RULE_LIST_INVALID");
  const active = listed.rules.filter((rule) => asRecord(rule).status === "active");
  const maximum = active.reduce(
    (current, rule) =>
      Math.max(current, requireInteger(asRecord(rule).min_topup_cents, "BONUS_RULE_LIST_INVALID")),
    0,
  );
  requireThat(maximum <= 4_890_000, "BONUS_THRESHOLD_UNAVAILABLE");
  return Math.max(10_000, maximum + 10_000);
}

export async function memberJourney(api, credentials, artifacts, run, update) {
  const topupCents = await activeBonusThreshold(api, artifacts.adminSession);
  const ruleInput = {
    min_topup_cents: topupCents,
    bonus_cents: 1_000,
    status: "active",
    note: run.note,
  };
  const rule = asRecord(
    await writeMutation(
      update,
      { bonusRuleLocator: Object.freeze({ ...ruleInput }) },
      () => api.confirm(artifacts.adminSession, "member.bonus_rule.upsert", ruleInput),
      (value) => {
        const record = asRecord(value);
        const ruleId = requireUuid(record.rule_id, "BONUS_RULE_UPSERT_INVALID");
        update({ bonusRule: Object.freeze({ ...ruleInput, rule_id: ruleId }) });
        return record;
      },
    ),
  );
  const ruleId = requireUuid(rule.rule_id, "BONUS_RULE_UPSERT_INVALID");
  const bonusRule = Object.freeze({ ...ruleInput, rule_id: ruleId });
  const opened = asRecord(
    await writeMutation(
      update,
      {
        memberAccountLocator: Object.freeze({
          customerId: artifacts.customerId,
          customerPhone: artifacts.customerPhone,
          note: run.note,
        }),
      },
      () =>
        api.command(artifacts.adminSession, "member.account.open", {
          customer_id: artifacts.customerId,
          note: run.note,
        }),
      (value) => {
        const record = asRecord(value);
        update({ memberAccountId: requireUuid(record.account_id, "MEMBER_OPEN_INVALID") });
        return record;
      },
    ),
  );
  const accountId = requireUuid(opened.account_id, "MEMBER_OPEN_INVALID");
  requireThat(
    typeof opened.created === "boolean" && opened.status === "active",
    "MEMBER_OPEN_INVALID",
  );
  const topup = asRecord(
    await writeMutation(update, {}, () =>
      api.confirm(artifacts.adminSession, "member.topup", {
        account_id: accountId,
        amount_cents: topupCents,
        method: "cash",
        note: run.note,
      }),
    ),
  );
  requireThat(
    topup.principal_cents === topupCents &&
      topup.bonus_cents === 1_000 &&
      topup.balance_cents === topupCents + 1_000,
    "MEMBER_TOPUP_INVALID",
  );
  const memberOrder = asRecord(
    await writeMutation(
      update,
      {
        memberOrderLocator: Object.freeze({
          customerPhone: artifacts.customerPhone,
          customerName: run.label,
          note: run.note,
        }),
      },
      () => api.command(artifacts.adminSession, "order.receive", orderArgs(artifacts, run)),
      (value) => {
        const record = asRecord(value);
        update({ memberOrderId: requireUuid(record.order_id, "ORDER_RECEIVE_INVALID") });
        return record;
      },
    ),
  );
  const memberOrderId = requireUuid(memberOrder.order_id, "ORDER_RECEIVE_INVALID");
  const memberOrderChargeCents = requireInteger(memberOrder.balance_cents, "ORDER_RECEIVE_INVALID");
  requireThat(
    memberOrderChargeCents > 0 &&
      memberOrder.payable_cents === memberOrderChargeCents &&
      memberOrder.paid_cents === 0,
    "ORDER_RECEIVE_INVALID",
  );
  update({ memberOrderChargeCents });
  const balancePayInput = Object.freeze({
    account_id: accountId,
    order_id: memberOrderId,
    amount_cents: memberOrderChargeCents,
    note: run.note,
  });
  let view = asRecord(
    await api.query(artifacts.adminSession, "member.account.get", {
      customer_id: artifacts.customerId,
    }),
  );
  let account = asRecord(view.account, "MEMBER_ACCOUNT_INVALID");
  await writeMutation(update, {}, () =>
    api.confirm(artifacts.adminSession, "member.account.freeze", {
      account_id: accountId,
      expected_customer_id: artifacts.customerId,
      expected_status_version: account.status_version,
      reason: run.note,
    }),
  );
  view = asRecord(
    await api.query(artifacts.adminSession, "member.account.get", {
      customer_id: artifacts.customerId,
    }),
  );
  account = asRecord(view.account, "MEMBER_ACCOUNT_INVALID");
  requireThat(account.status === "frozen", "MEMBER_FREEZE_INVALID");
  const frozenAccountBefore = stableJson(view);
  const frozenOrderBefore = stableJson(
    await api.query(artifacts.adminSession, "order.get", { order_id: memberOrderId }),
  );
  update({ cleanupUncertain: true });
  await api.expectCommandFailure(
    artifacts.adminSession,
    "member.balance.pay",
    balancePayInput,
    "INVARIANT_FAILED",
  );
  const frozenAccountAfter = stableJson(
    await api.query(artifacts.adminSession, "member.account.get", {
      customer_id: artifacts.customerId,
    }),
  );
  const frozenOrderAfter = stableJson(
    await api.query(artifacts.adminSession, "order.get", { order_id: memberOrderId }),
  );
  requireThat(
    frozenAccountAfter === frozenAccountBefore && frozenOrderAfter === frozenOrderBefore,
    "MEMBER_FROZEN_FUNDS_CHANGED",
  );
  update({ cleanupUncertain: false });
  await writeMutation(update, {}, () =>
    api.confirm(artifacts.adminSession, "member.account.unfreeze", {
      account_id: accountId,
      expected_customer_id: artifacts.customerId,
      expected_status_version: account.status_version,
      reason: run.note,
    }),
  );
  view = asRecord(
    await api.query(artifacts.adminSession, "member.account.get", {
      customer_id: artifacts.customerId,
    }),
  );
  account = asRecord(view.account, "MEMBER_ACCOUNT_INVALID");
  requireThat(account.status === "active", "MEMBER_UNFREEZE_INVALID");
  const paid = asRecord(
    await writeMutation(update, {}, () =>
      api.command(artifacts.adminSession, "member.balance.pay", balancePayInput),
    ),
  );
  requireThat(
    paid.order_balance_cents === 0 &&
      paid.balance_cents === topupCents + 1_000 - memberOrderChargeCents,
    "MEMBER_BALANCE_PAY_INVALID",
  );
  await writeMutation(update, {}, () =>
    api.command(artifacts.adminSession, "order.pickup", {
      order_id: memberOrderId,
      garment_ids: [],
      collect_cents: 0,
    }),
  );
  const refunded = asRecord(
    await writeMutation(update, {}, () =>
      api.stepUp(
        artifacts.adminSession,
        "member.refund",
        {
          account_id: accountId,
          amount_cents: 1_000,
          tender: "cash",
          reason: run.note,
          note: run.note,
        },
        artifacts.approverSession.staffId,
        credentials.approver.pin,
      ),
    ),
  );
  requireThat(
    refunded.principal_cents === topupCents - memberOrderChargeCents && refunded.bonus_cents === 0,
    "MEMBER_REFUND_INVALID",
  );
  view = asRecord(
    await api.query(artifacts.adminSession, "member.account.get", {
      customer_id: artifacts.customerId,
    }),
  );
  account = asRecord(view.account, "MEMBER_ACCOUNT_INVALID");
  const closed = asRecord(
    await writeMutation(update, {}, () =>
      api.stepUp(
        artifacts.adminSession,
        "member.account.close",
        {
          account_id: accountId,
          expected_customer_id: artifacts.customerId,
          expected_status_version: account.status_version,
          expected_status: account.status,
          expected_principal_cents: account.principal_cents,
          expected_bonus_cents: account.bonus_cents,
          refund_tender: account.principal_cents > 0 ? "cash" : null,
          reason: run.note,
        },
        artifacts.approverSession.staffId,
        credentials.approver.pin,
      ),
    ),
  );
  requireThat(closed.status === "closed" && closed.balance_cents === 0, "MEMBER_CLOSE_INVALID");
  update({ memberClosed: true });
  await writeMutation(update, {}, () =>
    api.confirm(artifacts.adminSession, "member.bonus_rule.upsert", {
      ...bonusRule,
      status: "retired",
    }),
  );
  update({ bonusRuleRetired: true });
}
