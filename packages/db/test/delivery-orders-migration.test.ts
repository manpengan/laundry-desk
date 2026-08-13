import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "migrations");
const readMigration = (): string =>
  readFileSync(join(migrationsDir, "0056_delivery_orders.sql"), "utf8");

describe("0056 delivery orders migration", () => {
  it("binds store-scoped laundry orders and both appointment legs", () => {
    const sql = readMigration();
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.delivery_orders/iu);
    expect(sql).toMatch(
      /FOREIGN KEY \(org_id, store_id, laundry_order_id\)[\s\S]*public\.orders/iu,
    );
    expect(sql).toMatch(/delivery_orders_pickup_appointment_fk[\s\S]*delivery_appointments/iu);
    expect(sql).toMatch(/delivery_orders_return_appointment_fk[\s\S]*delivery_appointments/iu);
    expect(sql).toMatch(/delivery_orders_active_laundry_order_uidx/iu);
    expect(sql).toMatch(/delivery_orders_pickup_appointment_uidx/iu);
    expect(sql).toMatch(/delivery_orders_return_appointment_uidx/iu);
  });

  it("derives canonical customer, fees and initial state inside the database guard", () => {
    const sql = readMigration();
    expect(sql).toMatch(/customer_canonical_root\(requested\.id\)/iu);
    expect(sql).toMatch(/NEW\.customer_id := canonical_customer_id/iu);
    expect(sql).toMatch(/NEW\.pickup_fee_cents := pickup_fee/iu);
    expect(sql).toMatch(/NEW\.return_fee_cents := return_fee/iu);
    expect(sql).toMatch(/NEW\.total_fee_cents := pickup_fee \+ return_fee/iu);
    expect(sql).toMatch(/WHEN 'pickup' THEN 'pickup_scheduled' ELSE 'at_store'/iu);
    expect(sql).toMatch(/delivery feature is disabled/iu);
    expect(sql).toMatch(/JOIN customer_addresses address_row/iu);
    expect(sql).toMatch(/address_row\.retired_at IS NULL/iu);
    expect(sql).toMatch(/address_row\.pii_purged_at IS NULL/iu);
  });

  it("forces CAS, legal transitions, readiness and irreversible terminal states", () => {
    const sql = readMigration();
    expect(sql).toMatch(/delivery_order_transition_allowed/iu);
    expect(sql).toMatch(/version must advance by one/iu);
    expect(sql).toMatch(/terminal delivery order is immutable/iu);
    expect(sql).toMatch(/laundry order is not ready for return/iu);
    expect(sql).toMatch(/laundry order is not terminal for delivery/iu);
    expect(sql).toMatch(/status = 'closed' AND balance_cents = 0/iu);
    expect(sql).toMatch(/bound delivery appointment is immutable/iu);
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE ON public\.delivery_orders/iu);
  });

  it("forces org/store RLS, denies deletion and reuses R3 pending cards", () => {
    const sql = readMigration();
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/iu);
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/iu);
    expect(sql).toMatch(/current_setting\('app\.org_id', true\)/iu);
    expect(sql).toMatch(/current_setting\('app\.store_id', true\)/iu);
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE ON TABLE public\.delivery_orders/iu);
    expect(sql).toMatch(/REVOKE DELETE, TRUNCATE ON TABLE public\.delivery_orders/iu);
    expect(sql).toMatch(/ai_pending_delivery_order_idempotency_uidx/iu);
    expect(sql).toContain("'delivery.order.create'");
    expect(sql).toContain("'delivery.order.transition'");
  });

  it("stores opaque references and controlled reason codes without evidence payloads", () => {
    const sql = readMigration();
    expect(sql).not.toMatch(
      /\b(?:recipient|contact_phone|address_body|latitude|longitude|photo|signature|gps|route_json)\s+(?:text|jsonb|numeric|double precision)/iu,
    );
    expect(sql).toMatch(/appointment_cancelled.*duplicate.*other/isu);
  });
});
