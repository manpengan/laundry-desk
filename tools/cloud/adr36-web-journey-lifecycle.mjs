import { asRecord, requireThat } from "./adr36-web-core.mjs";
import {
  accountingReport,
  assertBasis,
  expectedAccountingDelta,
  staffBasis,
  subtractBasis,
} from "./adr36-web-journey-support.mjs";

export async function accountingDeltaJourney(api, artifacts) {
  const expected = expectedAccountingDelta(artifacts.memberOrderChargeCents);
  const afterDay = await accountingReport(api, artifacts.adminSession, {
    date_from: artifacts.accountingBaselineDay.date,
    date_to: artifacts.accountingBaselineDay.date,
    group_by: "day",
  });
  const afterStaff = await accountingReport(api, artifacts.adminSession, {
    date_from: artifacts.accountingBaselineDay.date,
    date_to: artifacts.accountingBaselineDay.date,
    group_by: "staff",
  });
  requireThat(
    afterDay.date === artifacts.accountingBaselineDay.date && afterStaff.date === afterDay.date,
    "BUSINESS_DAY_ROLLOVER",
  );
  assertBasis(subtractBasis(afterDay.totals, artifacts.accountingBaselineDay.totals), expected);
  const beforeActor = staffBasis(artifacts.accountingBaselineStaff, artifacts.adminSession.staffId);
  const afterActor = staffBasis(afterStaff, artifacts.adminSession.staffId);
  assertBasis(subtractBasis(afterActor, beforeActor), expected, "ACCOUNTING_STAFF_DELTA_INVALID");
}

async function settleOpenOrder(api, artifacts, orderId, note) {
  if (orderId === null) return;
  let order = asRecord(await api.query(artifacts.adminSession, "order.get", { order_id: orderId }));
  if (order.status !== "open") return;
  for (const row of order.garments) {
    const garment = asRecord(row);
    if (garment.status === "washing" || garment.status === "reworked") {
      await api.command(artifacts.adminSession, "garment.transition", {
        garment_id: garment.garment_id,
        target_status: "ready",
        note,
      });
    }
  }
  order = asRecord(await api.query(artifacts.adminSession, "order.get", { order_id: orderId }));
  const selected = order.garments.filter((row) =>
    ["received", "ready", "racked"].includes(asRecord(row).status),
  );
  const verification = selected
    .filter((row) => asRecord(row).status === "racked")
    .map((row) => asRecord(row).barcode);
  await api.command(artifacts.adminSession, "order.pickup", {
    order_id: orderId,
    garment_ids: selected.map((row) => asRecord(row).garment_id),
    verification_barcodes: verification,
    collect_cents: order.balance_cents,
  });
  const closed = asRecord(
    await api.query(artifacts.adminSession, "order.get", { order_id: orderId }),
  );
  requireThat(closed.status === "closed" && closed.balance_cents === 0, "CLEANUP_ORDER_INCOMPLETE");
}

async function closeOpenMember(api, credentials, artifacts, note) {
  if (artifacts.memberAccountId === null || artifacts.memberClosed) return;
  const view = asRecord(
    await api.query(artifacts.adminSession, "member.account.get", {
      customer_id: artifacts.customerId,
    }),
  );
  const account = asRecord(view.account, "CLEANUP_MEMBER_INCOMPLETE");
  if (account.status === "closed") return;
  requireThat(artifacts.approvalHealthy, "CLEANUP_APPROVAL_UNSAFE");
  await api.stepUp(
    artifacts.adminSession,
    "member.account.close",
    {
      account_id: account.account_id,
      expected_customer_id: account.customer_id,
      expected_status_version: account.status_version,
      expected_status: account.status,
      expected_principal_cents: account.principal_cents,
      expected_bonus_cents: account.bonus_cents,
      refund_tender: account.principal_cents > 0 ? "cash" : null,
      reason: note,
    },
    artifacts.approverSession.staffId,
    credentials.approver.pin,
  );
  const closed = asRecord(
    asRecord(
      await api.query(artifacts.adminSession, "member.account.get", {
        customer_id: artifacts.customerId,
      }),
    ).account,
  );
  requireThat(
    closed.status === "closed" && closed.balance_cents === 0,
    "CLEANUP_MEMBER_INCOMPLETE",
  );
}

export async function cleanupArtifacts(api, credentials, artifacts, run) {
  if (artifacts.adminSession === null) return !artifacts.cleanupUncertain;
  let complete = true;
  const attempt = async (operation) => {
    try {
      await operation();
    } catch {
      complete = false;
    }
  };
  await attempt(() => settleOpenOrder(api, artifacts, artifacts.cashOrderId, run.note));
  await attempt(() => settleOpenOrder(api, artifacts, artifacts.benefitOrderId, run.note));
  await attempt(() => settleOpenOrder(api, artifacts, artifacts.memberOrderId, run.note));
  await attempt(() => closeOpenMember(api, credentials, artifacts, run.note));
  if (artifacts.bonusRule !== null && !artifacts.bonusRuleRetired) {
    await attempt(() =>
      api.confirm(artifacts.adminSession, "member.bonus_rule.upsert", {
        ...artifacts.bonusRule,
        status: "retired",
      }),
    );
  }
  if (artifacts.catalogItem !== null) {
    await attempt(async () => {
      await api.command(artifacts.adminSession, "catalog.item.upsert", {
        ...artifacts.catalogItem,
        is_active: false,
      });
      const view = asRecord(
        await api.query(artifacts.adminSession, "catalog.items.get", {
          code: artifacts.catalogItem.code,
        }),
      );
      requireThat(view.item === null, "CLEANUP_CATALOG_INCOMPLETE");
    });
  }
  return complete && !artifacts.cleanupUncertain;
}

export async function logoutSessions(api, artifacts) {
  let complete = true;
  for (const session of [artifacts.approverSession, artifacts.adminSession]) {
    if (session === null) continue;
    try {
      await api.logout(session);
    } catch {
      complete = false;
    }
  }
  return complete;
}

export function initialArtifacts() {
  return Object.freeze({
    cleanupUncertain: false,
    adminSession: null,
    approverSession: null,
    accountingBaselineDay: null,
    accountingBaselineStaff: null,
    catalogItem: null,
    customerId: null,
    customerPhone: null,
    customerName: null,
    customerNote: null,
    cashOrderId: null,
    cashOrderLocator: null,
    benefitOrderId: null,
    benefitOrderLocator: null,
    customerProfileTierOrderLocator: null,
    customerProfileCustomerOrderLocator: null,
    memberOrderId: null,
    memberOrderLocator: null,
    memberOrderChargeCents: null,
    memberAccountId: null,
    memberAccountLocator: null,
    memberClosed: false,
    bonusRule: null,
    bonusRuleLocator: null,
    bonusRuleRetired: false,
    approvalHealthy: true,
    authCleanupUncertain: false,
    reportingCleanupUncertain: false,
  });
}
