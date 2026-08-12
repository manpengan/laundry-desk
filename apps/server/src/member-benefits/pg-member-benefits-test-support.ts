import assert from "node:assert/strict";

import { executeCommand } from "../bus/executor.js";
import type { ActorContext } from "../bus/types.js";
import type { PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import type { TenantContext } from "../db/types.js";
import type { createRegisteredM1Bus } from "../handlers/register-m1.js";

type PgCommandFixture = Readonly<{
  tenant: TenantContext;
  actor: ActorContext;
  adminPool: PgPool;
  appPool: PgPool;
}>;

type RegisteredBus = ReturnType<typeof createRegisteredM1Bus>;
const FIXED_DATE = new Date("2026-08-11T08:00:00.000Z");

export async function executePgCommand(
  fixture: PgCommandFixture,
  bus: RegisteredBus,
  name: string,
  input: Readonly<Record<string, unknown>>,
  options: Readonly<{ idempotencyKey: string; confirmRef?: string }>,
) {
  return withPoolClient(fixture.appPool, (client) =>
    executeCommand(client, fixture.tenant, name, input, {
      registry: bus.registry,
      actor: fixture.actor,
      chainHooks: bus.chainHooks,
      idempotencyKey: options.idempotencyKey,
      ...(options.confirmRef === undefined ? {} : { confirmRef: options.confirmRef }),
      now: () => FIXED_DATE,
    }),
  );
}

export async function confirmedPgCommand(
  fixture: PgCommandFixture,
  bus: RegisteredBus,
  name: string,
  input: Readonly<Record<string, unknown>>,
  idempotencyKey: string,
) {
  const challenge = await executePgCommand(fixture, bus, name, input, { idempotencyKey });
  assert.equal(challenge.ok, false, JSON.stringify(challenge));
  if (challenge.ok) throw new Error(`${name} unexpectedly skipped confirmation`);
  assert.equal(challenge.error.code, "POLICY_CONFIRMATION_REQUIRED", JSON.stringify(challenge));
  const detail = "detail" in challenge.error ? challenge.error.detail : undefined;
  if (detail?.kind !== "confirmation") throw new Error(`${name} confirm_ref missing`);
  return executePgCommand(
    fixture,
    bus,
    name,
    {},
    {
      idempotencyKey,
      confirmRef: detail.confirm_ref,
    },
  );
}

export const confirmedOrderCancel = (
  fixture: PgCommandFixture,
  bus: RegisteredBus,
  orderId: string,
  idempotencyKey: string,
) =>
  confirmedPgCommand(
    fixture,
    bus,
    "order.cancel",
    { order_id: orderId, reason: "客户取消" },
    idempotencyKey,
  );

export async function waitForBackendLock(
  fixture: PgCommandFixture,
  backendPid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const activity = await fixture.adminPool.query<Readonly<{ wait_event_type: string | null }>>(
      `SELECT wait_event_type
         FROM pg_stat_activity
        WHERE pid = $1`,
      [backendPid],
    );
    if (activity.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("member benefit definition read did not wait on the retiring row lock");
}
