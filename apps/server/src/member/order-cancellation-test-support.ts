import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { CommandHandler } from "../bus/types.js";
import { createM1CommandRegistry } from "../bus/registry.js";
import { writeAuditForOutcome } from "../bus/audit-outcome.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import type { OrderStore } from "../order/types.js";
import { createMemberHandlers, type MemberRuntimeDeps } from "./handlers.js";
import { registerOrderWorkdayCommandHandlers } from "../order/workday-handlers.js";
import { registerPaymentCommandHandlers } from "../payment/handlers.js";
import { pickupHandler } from "../order/pickup-handler.js";
import { withMemberBalanceCancellation } from "./order-cancellation.js";

export const CANCEL_DAY = "2026-10-23";
export const CANCEL_AT = Math.floor(Date.parse("2026-10-23T04:00:00Z") / 1_000);

export async function seedCancellationOrder(
  order: OrderStore,
  tenant: TenantContext,
  customerId: string,
  garmentStatus: "received" | "ready" = "received",
) {
  const orderId = randomUUID();
  await order.insertOrder(
    {
      order_id: orderId,
      org_id: tenant.orgId,
      store_id: tenant.storeId,
      ticket_no: `C${orderId}`,
      pickup_code: null,
      status: "open",
      customer_id: customerId,
      customer_phone: null,
      customer_name: null,
      note: null,
      lines: [
        {
          line_index: 0,
          service_code: "wash",
          category_code: "shirt",
          unit_price_cents: 4200,
          qty: 1,
          line_total_cents: 4200,
          color: null,
          brand: null,
        },
      ],
      subtotal_cents: 4200,
      original_cents: 4200,
      discount_cents: 0,
      addon_cents: 0,
      urgent_cents: 0,
      freight_cents: 0,
      payable_cents: 4200,
      paid_cents: 0,
      balance_cents: 4200,
      created_at: CANCEL_AT,
      updated_at: CANCEL_AT,
      business_date: CANCEL_DAY,
      created_by_staff_id: tenant.staffId,
    },
    [
      {
        garment_id: randomUUID(),
        org_id: tenant.orgId,
        store_id: tenant.storeId,
        order_id: orderId,
        line_index: 0,
        seq: 1,
        barcode: `G${orderId}`,
        service_code: "wash",
        category_code: "shirt",
        unit_price_cents: 4200,
        color: null,
        brand: null,
        status: garmentStatus,
        custody_state: "store",
        active_production_batch_id: null,
      },
    ],
  );
  return orderId;
}

export function cancellationHandlers(order: OrderStore, member: MemberRuntimeDeps) {
  const deps = withMemberBalanceCancellation(
    { store: order, now: () => CANCEL_AT, timeZone: "UTC" },
    member,
  );
  const handlers: Record<string, CommandHandler> = {
    ...createMemberHandlers({ ...member, order: deps }),
  };
  registerOrderWorkdayCommandHandlers(
    {
      registerHandler: (name, handler) => {
        handlers[name] = handler;
      },
    },
    deps,
  );
  registerPaymentCommandHandlers(
    {
      registerHandler: (name, handler) => {
        handlers[name] = handler;
      },
    },
    deps,
  );
  handlers["order.pickup"] = pickupHandler(deps);
  return handlers;
}

export async function runCancellationHandler(
  client: SqlClient,
  tenant: TenantContext,
  handlers: Record<string, CommandHandler>,
  name: string,
  input: Readonly<Record<string, unknown>>,
  failAfterAudit = false,
) {
  return withTenantTransaction(client, tenant, async (tx) => {
    const handler = handlers[name];
    assert.ok(handler);
    const definition = createM1CommandRegistry().get(name)?.definition;
    assert.ok(definition);
    const ctx = {
      definition,
      client: tx,
      tenant,
      actor: {
        staffId: tenant.staffId,
        deviceId: null,
        via: "ui" as const,
        permissions: [
          "customer_write",
          "customer_read",
          "order_write",
          "member_lifecycle_manage",
          "member_refund",
          "payment_write",
          "payment_refund",
        ],
      },
      request: { name, version: "1.0.0", input, dryRun: false },
      parsed: input,
    };
    const outcome = await handler(ctx);
    await writeAuditForOutcome(tx, ctx, outcome.audit, { now: () => new Date(CANCEL_AT * 1000) });
    if (failAfterAudit) throw new Error("Injected failure after financial writes and audit");
    return outcome;
  });
}
