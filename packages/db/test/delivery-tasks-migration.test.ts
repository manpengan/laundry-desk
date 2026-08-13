import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "migrations");
const readMigration = (): string =>
  readFileSync(join(migrationsDir, "0057_delivery_tasks.sql"), "utf8");

describe("0057 delivery tasks migration", () => {
  it("binds one active task to a supported delivery-order leg and active store staff", () => {
    const sql = readMigration();
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.delivery_tasks/iu);
    expect(sql).toMatch(/delivery_tasks_order_fk[\s\S]*delivery_orders/iu);
    expect(sql).toMatch(/delivery_tasks_assignee_role_fk[\s\S]*staff_store_roles/iu);
    expect(sql).toMatch(/delivery_tasks_active_leg_uidx/iu);
    expect(sql).toMatch(/role_row\.is_active AND staff_row\.is_active/iu);
    expect(sql).toMatch(/delivery task leg is not assignable/iu);
  });

  it("enforces immutable history, CAS and successor-chain state transitions", () => {
    const sql = readMigration();
    expect(sql).toMatch(/delivery_task_transition_allowed/iu);
    expect(sql).toMatch(/delivery task version must advance by one/iu);
    expect(sql).toMatch(/terminal delivery task is immutable/iu);
    expect(sql).toMatch(/delivery_tasks_predecessor_uidx/iu);
    expect(sql).toMatch(/delivery task reusable predecessor required/iu);
    expect(sql).toMatch(/predecessor_status <> 'transferred'/iu);
    expect(sql).toMatch(/predecessor_status <> 'taken_over'/iu);
    expect(sql).toMatch(/reassignment requires active admin/iu);
    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER delivery_task_commit_integrity_trg/iu);
    expect(sql).toMatch(/DEFERRABLE INITIALLY DEFERRED/iu);
    expect(sql).toMatch(/terminal reassignment requires successor task/iu);
  });

  it("requires an accepted assignee before execution and closes tasks from order truth", () => {
    const sql = readMigration();
    expect(sql).toMatch(/guard_delivery_order_task_authority/iu);
    expect(sql).toMatch(/requires accepted assignee task/iu);
    expect(sql).toMatch(/sync_delivery_task_from_order/iu);
    expect(sql).toMatch(/NEW\.status = 'picked_up'/iu);
    expect(sql).toMatch(/NEW\.status = 'cancelled'/iu);
    expect(sql).toMatch(/terminal task must follow delivery order truth/iu);
  });

  it("forces store RLS, denies deletion and reuses durable confirmation cards", () => {
    const sql = readMigration();
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/iu);
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/iu);
    expect(sql).toMatch(/current_setting\('app\.org_id', true\)/iu);
    expect(sql).toMatch(/current_setting\('app\.store_id', true\)/iu);
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE ON TABLE public\.delivery_tasks/iu);
    expect(sql).toMatch(/REVOKE DELETE, TRUNCATE ON TABLE public\.delivery_tasks/iu);
    expect(sql).toMatch(/ai_pending_delivery_task_idempotency_uidx/iu);
    expect(sql).toContain("'delivery.task.takeover'");
  });

  it("contains no Item 5 or Item 6 location and evidence payloads", () => {
    const sql = readMigration();
    expect(sql).not.toMatch(
      /\b(?:address_body|latitude|longitude|photo|signature|gps|route_json)\s+(?:text|jsonb|numeric|double precision)/iu,
    );
  });
});
