import { asRecord, fail, requireString, requireThat, requireUuid } from "./adr36-web-core.mjs";
import { accountingReport, orderArgs, writeMutation } from "./adr36-web-journey-support.mjs";

export function syntheticRun(now, runUuid) {
  const compact = now.toISOString().replace(/[-:.]/gu, "").replace("000Z", "Z");
  const suffix = runUuid.replaceAll("-", "").slice(0, 8).toLowerCase();
  return Object.freeze({
    runId: `ADR36-${compact}-${suffix}`,
    label: `ADR36 UAT ${compact.slice(0, 15)} ${suffix}`,
    note: `ADR36-UAT-${compact}-${suffix}`,
    catalogCode: `uat_${compact.slice(0, 8).toLowerCase()}_${suffix}`,
    serviceCode: `uat_s_${suffix}`,
    categoryCode: `uat_c_${suffix}`,
    rackSlot: suffix.slice(0, 8),
    phoneStart: Number.parseInt(suffix.slice(0, 6), 16) % 1_000,
  });
}

export async function authJourney(api, credentials, update) {
  update({ authCleanupUncertain: true });
  const adminLogin = await api.login(credentials.admin);
  update({ adminSession: adminLogin, authCleanupUncertain: false });
  update({ authCleanupUncertain: true });
  const admin = await api.refresh(adminLogin);
  update({ adminSession: admin, authCleanupUncertain: false });
  update({ authCleanupUncertain: true });
  const approverLogin = await api.login(credentials.approver);
  update({ approverSession: approverLogin, authCleanupUncertain: false });
  update({ authCleanupUncertain: true });
  const approver = await api.refresh(approverLogin);
  update({ approverSession: approver, authCleanupUncertain: false });
  requireThat(admin.staffId !== approver.staffId, "ADMIN_IDENTITIES_NOT_DISTINCT");
  const directory = await api.staff(admin);
  requireThat(Array.isArray(directory), "STAFF_DIRECTORY_INVALID");
  for (const [principal, session] of [
    [credentials.admin, admin],
    [credentials.approver, approver],
  ]) {
    const entries = directory.filter(
      (entry) => asRecord(entry, "STAFF_DIRECTORY_INVALID").username === principal.username,
    );
    requireThat(entries.length === 1, "STAFF_DIRECTORY_INVALID");
    const entry = asRecord(entries[0], "STAFF_DIRECTORY_INVALID");
    requireThat(
      entry.staff_id === session.staffId &&
        entry.display_name === principal.displayName &&
        entry.role === "admin" &&
        entry.privacy_admin === true,
      "STAFF_DIRECTORY_INVALID",
    );
  }
}

export async function baselineJourney(api, artifacts, update) {
  const day = await accountingReport(api, artifacts.adminSession, { group_by: "day" });
  const staff = await accountingReport(api, artifacts.adminSession, {
    date_from: day.date,
    date_to: day.date,
    group_by: "staff",
  });
  requireThat(staff.date === day.date, "ACCOUNTING_DATE_INVALID");
  update({ accountingBaselineDay: day, accountingBaselineStaff: staff });
}

export async function catalogJourney(api, artifacts, run, update) {
  const prior = asRecord(
    await api.query(artifacts.adminSession, "catalog.items.get", { code: run.catalogCode }),
  );
  requireThat(prior.item === null, "UAT_CATALOG_COLLISION");
  const item = Object.freeze({
    code: run.catalogCode,
    name: run.label,
    service_code: run.serviceCode,
    category_code: run.categoryCode,
    unit_price_cents: 2_600,
    is_active: true,
    sort_order: 9_999,
  });
  const result = asRecord(
    await writeMutation(
      update,
      { catalogItem: item },
      () => api.command(artifacts.adminSession, "catalog.item.upsert", item),
      (value) => asRecord(value),
    ),
  );
  requireThat(result.code === item.code && result.created === true, "CATALOG_UPSERT_INVALID");
  const listed = asRecord(
    await api.query(artifacts.adminSession, "catalog.items.list", { query: item.code, limit: 10 }),
  );
  requireThat(
    Array.isArray(listed.items) &&
      listed.items.some((value) => {
        const row = asRecord(value);
        return (
          row.code === item.code &&
          row.name === item.name &&
          row.service_code === item.service_code &&
          row.category_code === item.category_code &&
          row.unit_price_cents === item.unit_price_cents
        );
      }),
    "CATALOG_LIST_INVALID",
  );
}

export async function customerJourney(api, artifacts, run, update) {
  for (let offset = 0; offset < 32; offset += 1) {
    const tail = String((run.phoneStart + offset) % 1_000).padStart(3, "0");
    const phone = `13800000${tail}`;
    const found = asRecord(
      await api.query(artifacts.adminSession, "customer.search", { query: phone, limit: 10 }),
    );
    requireThat(Array.isArray(found.customers), "CUSTOMER_SEARCH_INVALID");
    if (found.customers.length > 0) continue;
    const input = Object.freeze({ phone, name: run.label, note: run.note });
    const created = asRecord(
      await writeMutation(
        update,
        { customerPhone: phone, customerName: run.label, customerNote: run.note },
        () => api.command(artifacts.adminSession, "customer.upsert", input),
        (value) => {
          const record = asRecord(value);
          update({ customerId: requireUuid(record.customer_id, "CUSTOMER_CREATE_INVALID") });
          return record;
        },
      ),
    );
    requireThat(created.created === true && created.phone === phone, "CUSTOMER_CREATE_INVALID");
    return;
  }
  fail("UAT_PHONE_RANGE_EXHAUSTED");
}

export async function cashOrderJourney(api, artifacts, run, update) {
  const input = orderArgs(artifacts, run, {
    amount_cents: 1_000,
    method: "cash",
    note: run.note,
  });
  const received = asRecord(
    await writeMutation(
      update,
      {
        cashOrderLocator: Object.freeze({
          customerPhone: artifacts.customerPhone,
          customerName: run.label,
          note: run.note,
        }),
      },
      () => api.command(artifacts.adminSession, "order.receive", input),
      (value) => {
        const record = asRecord(value);
        update({ cashOrderId: requireUuid(record.order_id, "ORDER_RECEIVE_INVALID") });
        return record;
      },
    ),
  );
  const orderId = requireUuid(received.order_id, "ORDER_RECEIVE_INVALID");
  requireThat(
    received.payable_cents === 2_600 &&
      received.paid_cents === 1_000 &&
      received.balance_cents === 1_600 &&
      Array.isArray(received.garments) &&
      received.garments.length === 1,
    "ORDER_RECEIVE_INVALID",
  );
  const garment = asRecord(received.garments[0], "ORDER_RECEIVE_INVALID");
  const garmentId = requireUuid(garment.garment_id, "ORDER_RECEIVE_INVALID");
  const barcode = requireString(garment.barcode, "ORDER_RECEIVE_INVALID");
  const receivedWork = asRecord(
    await api.query(artifacts.adminSession, "fulfillment.workbench", {
      statuses: ["received"],
      key: barcode,
      limit: 10,
    }),
  );
  requireThat(
    Array.isArray(receivedWork.garments) &&
      receivedWork.garments.some((row) => asRecord(row).garment_id === garmentId),
    "FULFILLMENT_QUERY_INVALID",
  );
  await writeMutation(update, {}, () =>
    api.command(artifacts.adminSession, "garment.transition", {
      garment_id: garmentId,
      target_status: "washing",
      note: run.note,
    }),
  );
  await writeMutation(update, {}, () =>
    api.command(artifacts.adminSession, "garment.transition", {
      garment_id: garmentId,
      target_status: "ready",
      note: run.note,
    }),
  );
  await writeMutation(update, {}, () =>
    api.command(artifacts.adminSession, "garment.rack.assign", {
      barcode,
      rack_zone: "UAT",
      rack_slot: run.rackSlot,
    }),
  );
  const racked = asRecord(
    await api.query(artifacts.adminSession, "fulfillment.workbench", {
      statuses: ["racked"],
      key: barcode,
      limit: 10,
    }),
  );
  requireThat(
    Array.isArray(racked.garments) &&
      racked.garments.some(
        (row) => asRecord(row).garment_id === garmentId && row.rack_zone === "UAT",
      ),
    "FULFILLMENT_RACK_INVALID",
  );
  await writeMutation(update, {}, () =>
    api.command(artifacts.adminSession, "order.pickup", {
      order_id: orderId,
      garment_ids: [garmentId],
      verification_barcodes: [barcode],
      collect_cents: 1_600,
    }),
  );
  const closed = asRecord(
    await api.query(artifacts.adminSession, "order.get", { order_id: orderId }),
  );
  requireThat(
    closed.status === "closed" &&
      closed.balance_cents === 0 &&
      Array.isArray(closed.garments) &&
      closed.garments.every((row) => asRecord(row).status === "picked_up"),
    "ORDER_PICKUP_INVALID",
  );
}
