import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "migrations");
const readMigration = (): string =>
  readFileSync(join(migrationsDir, "0055_delivery_appointments.sql"), "utf8");

describe("0055 delivery appointments migration", () => {
  it("creates an optimistic capacity ledger with tenant-safe identity references", () => {
    const sql = readMigration();
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.delivery_appointments/iu);
    expect(sql).toMatch(/FOREIGN KEY \(org_id, store_id\).*public\.stores/isu);
    expect(sql).toMatch(/FOREIGN KEY \(org_id, customer_id\).*public\.customers/isu);
    expect(sql).toMatch(/FOREIGN KEY \(org_id, address_id\).*customer_addresses/isu);
    expect(sql).toMatch(/delivery_appointments_slot_capacity_idx/iu);
    expect(sql).toMatch(/delivery_appointments_customer_slot_uidx/iu);
    expect(sql).toMatch(/delivery_appointments_store_worklist_idx/iu);
    expect(sql).toMatch(/WHERE status = 'scheduled'/iu);
    expect(sql).toMatch(/version integer NOT NULL DEFAULT 1/iu);
    expect(sql).toMatch(/policy_version integer NOT NULL/iu);
  });

  it("forces org/store RLS and denies physical deletion", () => {
    const sql = readMigration();
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/iu);
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/iu);
    expect(sql).toMatch(/current_setting\('app\.org_id', true\)/iu);
    expect(sql).toMatch(/current_setting\('app\.store_id', true\)/iu);
    expect(sql).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON TABLE public\.delivery_appointments TO laundry_app/iu,
    );
    expect(sql).toMatch(
      /REVOKE DELETE, TRUNCATE ON TABLE public\.delivery_appointments FROM laundry_app/iu,
    );
  });

  it("retains only opaque identity references and controlled cancellation state", () => {
    const sql = readMigration();
    expect(sql).not.toMatch(
      /\b(?:recipient|contact_phone|address_body|latitude|longitude|free_text)\s+(?:text|numeric|double precision)/iu,
    );
    expect(sql).toMatch(/customer_request.*store_request.*unreachable.*duplicate.*other/isu);
    expect(sql).toMatch(/delivery_appointments_cancellation_state_chk/iu);
    expect(sql).toMatch(/guard_delivery_appointment_write/iu);
    expect(sql).toMatch(/cancelled delivery appointment is immutable/iu);
    expect(sql).toMatch(/delivery appointment identity is immutable/iu);
    expect(sql).toMatch(/version must advance by one/iu);
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE ON public\.delivery_appointments/iu);
    expect(sql).toMatch(/FOR SHARE OF requested, root, owner, address_row/iu);
    expect(sql).not.toMatch(/UPDATE\s+(?:public\.)?store_features/iu);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+(?:public\.)?store_features/iu);
  });

  it("deduplicates all three R3 pending cards by command idempotency key", () => {
    const sql = readMigration();
    expect(sql).toMatch(/ai_pending_delivery_appointment_idempotency_uidx/iu);
    for (const command of [
      "delivery.appointment.create",
      "delivery.appointment.reschedule",
      "delivery.appointment.cancel",
    ]) {
      expect(sql).toContain(`'${command}'`);
    }
  });
});
