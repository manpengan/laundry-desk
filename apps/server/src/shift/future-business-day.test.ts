import assert from "node:assert/strict";
import test from "node:test";
import { HandlerCommandError, type CommandHandler } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import { createMemoryOrderStore } from "../order/memory-store.js";
import { createOrderBackedStatsQuery } from "../stats/memory-source.js";
import { registerShiftCommandHandlers } from "./handlers.js";
import { createMemoryShiftStore } from "./memory-store.js";

const tenant = {
  orgId: "10000000-0000-4000-8000-000000000001",
  storeId: "10000000-0000-4000-8000-000000000002",
  staffId: "10000000-0000-4000-8000-000000000003",
};
for (const scenario of [
  {
    now: "2026-10-23T18:59:59Z",
    zone: "Asia/Shanghai",
    rollover: 3,
    current: "2026-10-23",
    future: "2026-10-24",
  },
  {
    now: "2026-10-23T19:00:00Z",
    zone: "Asia/Shanghai",
    rollover: 3,
    current: "2026-10-24",
    future: "2026-10-25",
  },
  {
    now: "2026-10-24T01:00:00Z",
    zone: "America/Los_Angeles",
    rollover: 0,
    current: "2026-10-23",
    future: "2026-10-24",
  },
]) {
  test(`shift guard uses store day at ${scenario.now} ${scenario.zone}`, async () => {
    const store = createMemoryShiftStore();
    let handler: CommandHandler | undefined;
    let locks = 0;
    registerShiftCommandHandlers(
      {
        registerHandler: (_name, value) => {
          handler = value;
        },
      },
      {
        store,
        stats: createOrderBackedStatsQuery(createMemoryOrderStore()),
        now: () => Date.parse(scenario.now) / 1_000,
        timeZone: scenario.zone,
        rolloverHour: scenario.rollover,
        lockBusinessDay: async () => {
          locks += 1;
        },
      },
    );
    assert.ok(handler);
    const context = (date: string) => ({
      client: new FakeSqlClient(),
      tenant,
      actor: { staffId: tenant.staffId, deviceId: null, via: "ui" as const },
      request: { name: "shift.close", version: "1", input: {}, dryRun: false },
      parsed: {
        business_date: date,
        counted_cash_cents: 0,
        retained_float_cents: 0,
        signature_name: "测试",
      },
    });
    await assert.rejects(
      handler(context(scenario.future)),
      (error: unknown) =>
        error instanceof HandlerCommandError && error.commandError.code === "VALIDATION_FAILED",
    );
    assert.equal(locks, 0);
    assert.equal(
      await store.getByBusinessDate(tenant.orgId, tenant.storeId, scenario.future),
      null,
    );
    await handler(context(scenario.current));
    assert.equal(locks, 1);
    assert.ok(await store.getByBusinessDate(tenant.orgId, tenant.storeId, scenario.current));
  });
}
