import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { resolvePgUrls } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { executeCommand } from "../bus/executor.js";
import { createPgIdempotencyStore } from "../bus/pg-idempotency.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { createPgMemberDeps } from "./runtime.js";
import { CANCEL_AT, CANCEL_DAY } from "./order-cancellation-test-support.js";
import {
  createCancellationFixture,
  cancellationLifecycle,
} from "./pg-cancellation-test-support.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;

for (const bonus of [0, 1000, 5000]) {
  maybe(`PG cancellation restores exact funded split including bonus ${bonus}`, async () => {
    assert.ok(urls);
    const f = await createCancellationFixture(urls, bonus);
    try {
      await f.pay(4200);
      await f.cancel();
      assert.deepEqual((await f.view())?.balance, {
        principal_cents: 10000,
        bonus_cents: bonus,
        total_cents: 10000 + bonus,
      });
      const evidence = await f.adminPool.query<{
        principal_ok: boolean;
        bonus_ok: boolean;
        ref_ok: boolean;
      }>(
        `SELECT reversal.principal_delta_cents = -source.principal_delta_cents AS principal_ok,
          reversal.bonus_delta_cents = -source.bonus_delta_cents AS bonus_ok,
          payment.ref_payment_id = link.payment_id AS ref_ok
         FROM member_ledger reversal JOIN member_ledger source ON source.id = reversal.ref_ledger_id
         JOIN member_payment_links link ON link.ledger_id = source.id
         JOIN payments payment ON payment.ref_payment_id = link.payment_id AND payment.kind = 'reversal'
         WHERE reversal.org_id = $1 AND reversal.kind = 'reversal'`,
        [f.tenant.orgId],
      );
      assert.deepEqual(evidence.rows, [{ principal_ok: true, bonus_ok: true, ref_ok: true }]);
      assert.equal(
        await f.transaction((store) => store.sumCashPrincipal(f.tenant.storeId, CANCEL_DAY)),
        10000,
      );
      assert.equal((await f.payments()).length, 2);
      const audits = await f.adminPool.query(
        "SELECT id FROM audit_log WHERE org_id=$1 AND command='order.cancel'",
        [f.tenant.orgId],
      );
      assert.equal(audits.rows.length, 1);
      await assert.rejects(() => f.cancel());
      assert.equal((await f.view())?.recent.length, 3);
    } finally {
      await f.cleanup();
    }
  });
}

maybe("PG mixed tender and multiple member payments reverse each debit exactly once", async () => {
  assert.ok(urls);
  const f = await createCancellationFixture(urls, 1000);
  try {
    await f.pay(1200);
    await f.pay(1000);
    await f.order.appendPayment!({
      org_id: f.tenant.orgId,
      store_id: f.tenant.storeId,
      order_id: f.orderId,
      amount_cents: 2000,
      method: "cash",
      kind: "pay",
      staff_id: f.tenant.staffId,
      at: CANCEL_AT,
      business_date: CANCEL_DAY,
      note: null,
    });
    const concurrent = await Promise.allSettled([f.cancel(), f.cancel()]);
    assert.equal(concurrent.filter((row) => row.status === "fulfilled").length, 1);
    assert.equal((await f.view())?.balance.total_cents, 11000);
    assert.equal((await f.payments()).filter((row) => row.kind === "reversal").length, 3);
    assert.equal((await f.view())?.recent.filter((row) => row.kind === "reversal").length, 2);
  } finally {
    await f.cleanup();
  }
});

maybe("PG cancellation and a new balance payment cannot deadlock or strand a debit", async () => {
  assert.ok(urls);
  const f = await createCancellationFixture(urls, 1000);
  try {
    await f.pay(1200);
    await Promise.allSettled([f.cancel(), f.pay(1000)]);
    assert.equal(
      (await f.order.getOrder(f.tenant.orgId, f.tenant.storeId, f.orderId))?.status,
      "cancelled",
    );
    assert.equal((await f.view())?.balance.total_cents, 11000);
    const payments = await f.payments();
    assert.equal(
      payments.filter((row) => row.kind === "pay").length,
      payments.filter((row) => row.kind === "reversal").length,
    );
  } finally {
    await f.cleanup();
  }
});

maybe(
  "PG frozen and merged account returns remain attached to the original account ID",
  async () => {
    assert.ok(urls);
    const f = await createCancellationFixture(urls, 1000);
    try {
      await f.pay(4200);
      assert.ok(
        (
          await f.transaction((store) =>
            store.transitionStatus({ ...cancellationLifecycle(f), action: "freeze" }),
          )
        ).ok,
      );
      const target = randomUUID();
      await f.adminPool.query(
        "INSERT INTO customers (id,org_id,phone,created_at,updated_at) VALUES ($1,$2,'13900000000',now(),now())",
        [target, f.tenant.orgId],
      );
      await f.adminPool.query(
        "INSERT INTO staff_store_roles (id,org_id,store_id,staff_id,role,is_active,created_at,updated_at) VALUES (gen_random_uuid(),$1,$2,$3,'admin',true,now(),now())",
        [f.tenant.orgId, f.tenant.storeId, f.tenant.staffId],
      );
      await f.transaction(async (_store, tx) => {
        const merged = await tx.query("SELECT * FROM customer_merge_canonical($1,$2,now())", [
          f.customerId,
          target,
        ]);
        assert.equal(merged.rows.length, 1);
      });
      await f.cancel();
      const view = await f.view();
      assert.equal(view?.account.customer_id, target);
      assert.equal(view?.account.status, "frozen");
      assert.equal(view?.balance.total_cents, 11000);
    } finally {
      await f.cleanup();
    }
  },
);

maybe("PG closed account refuses cancellation atomically", async () => {
  assert.ok(urls);
  const f = await createCancellationFixture(urls);
  try {
    await f.pay(4200);
    assert.ok(
      (
        await f.transaction((store) =>
          store.close({
            ...cancellationLifecycle(f),
            expected_status: "active",
            expected_principal_cents: 5800,
            expected_bonus_cents: 0,
            refund_tender: "cash",
          }),
        )
      ).ok,
    );
    await assert.rejects(() => f.cancel());
    assert.equal((await f.view())?.balance.total_cents, 0);
    assert.equal((await f.payments()).length, 1);
    assert.equal(
      (await f.order.getOrder(f.tenant.orgId, f.tenant.storeId, f.orderId))?.status,
      "open",
    );
    const audits = await f.adminPool.query(
      "SELECT id FROM audit_log WHERE org_id=$1 AND command='order.cancel'",
      [f.tenant.orgId],
    );
    assert.equal(audits.rows.length, 0);
  } finally {
    await f.cleanup();
  }
});

maybe("PG audit/transaction failure rolls back wallet, payment, order and audit", async () => {
  assert.ok(urls);
  const f = await createCancellationFixture(urls, 1000);
  try {
    await assert.rejects(() => f.pay(4200, true), /Injected failure/u);
    assert.equal((await f.view())?.balance.total_cents, 11000);
    assert.equal((await f.payments()).length, 0);
    await f.pay(4200);
    await assert.rejects(() => f.cancel(true), /Injected failure/u);
    assert.equal((await f.view())?.balance.total_cents, 6800);
    assert.equal((await f.payments()).length, 1);
    assert.equal(
      (await f.order.getOrder(f.tenant.orgId, f.tenant.storeId, f.orderId))?.status,
      "open",
    );
    const audits = await f.adminPool.query(
      "SELECT id FROM audit_log WHERE org_id=$1 AND command='order.cancel'",
      [f.tenant.orgId],
    );
    assert.equal(audits.rows.length, 0);
    await f.cancel();
    assert.equal((await f.view())?.balance.total_cents, 11000);
  } finally {
    await f.cleanup();
  }
});

maybe(
  "PG missing legacy linkage fails closed, links are append-only and tenant scoped",
  async () => {
    assert.ok(urls);
    const f = await createCancellationFixture(urls);
    try {
      await f.pay(4200);
      await assert.rejects(
        () =>
          f.transaction(async (_store, tx) => {
            await tx.query("DELETE FROM member_payment_links WHERE org_id=$1", [f.tenant.orgId]);
          }),
        /permission denied/u,
      );
      await f.adminPool.query("DELETE FROM member_payment_links WHERE org_id=$1", [f.tenant.orgId]);
      await assert.rejects(() => f.cancel());
      assert.equal((await f.view())?.balance.total_cents, 5800);
      assert.equal((await f.payments()).length, 1);
    } finally {
      await f.cleanup();
    }
  },
);

maybe("PG command idempotency replays cancellation without a second wallet credit", async () => {
  assert.ok(urls);
  const f = await createCancellationFixture(urls);
  try {
    await f.pay(4200);
    const bus = createRegisteredM1Bus({
      order: { store: f.order, now: () => CANCEL_AT, timeZone: "UTC" },
      member: createPgMemberDeps(),
    });
    const actor = {
      staffId: f.tenant.staffId,
      deviceId: null,
      via: "ui" as const,
      permissions: ["order_write"],
    };
    const input = { order_id: f.orderId, reason: "重复请求回归" };
    const idempotencyKey = randomUUID();
    const execute = (confirmRef?: string) =>
      withPoolClient(f.appPool, (client) =>
        executeCommand(client, f.tenant, "order.cancel", confirmRef === undefined ? input : {}, {
          registry: bus.registry,
          actor,
          chainHooks: bus.chainHooks,
          idempotencyKey,
          idempotencyStore: createPgIdempotencyStore(f.appPool),
          now: () => new Date(),
          ...(confirmRef === undefined ? {} : { confirmRef }),
        }),
      );
    const challenge = await execute();
    assert.equal(challenge.ok, false);
    if (challenge.ok) throw new Error("confirmation expected");
    const detail = "detail" in challenge.error ? challenge.error.detail : undefined;
    assert.equal(detail?.kind, "confirmation");
    if (detail?.kind !== "confirmation") throw new Error("confirmation reference expected");
    const first = await execute(detail.confirm_ref);
    assert.equal(first.ok, true, JSON.stringify(first));
    const replay = await execute(detail.confirm_ref);
    assert.deepEqual(replay, first);
    assert.equal((await f.view())?.balance.total_cents, 10000);
    assert.equal((await f.payments()).length, 2);
    const evidence = await f.adminPool.query(
      "SELECT id FROM audit_log WHERE org_id=$1 AND command='order.cancel'",
      [f.tenant.orgId],
    );
    assert.equal(evidence.rows.length, 1);
  } finally {
    await f.cleanup();
  }
});

maybe("PG linkage enforces RLS, uniqueness and source/payment identity", async () => {
  assert.ok(urls);
  const f = await createCancellationFixture(urls);
  try {
    await f.pay(1200);
    const link = (
      await f.adminPool.query<{ ledger_id: string; payment_id: string }>(
        "SELECT ledger_id,payment_id FROM member_payment_links WHERE org_id=$1",
        [f.tenant.orgId],
      )
    ).rows[0];
    assert.ok(link);
    const hidden = await withPoolClient(f.appPool, (client) =>
      withTenantTransaction(client, { ...f.tenant, orgId: randomUUID() }, (tx) =>
        tx.query("SELECT * FROM member_payment_links"),
      ),
    );
    assert.equal(hidden.rows.length, 0);
    await assert.rejects(
      () =>
        f.transaction(async (_store, tx) => {
          await tx.query(
            "INSERT INTO member_payment_links (org_id,store_id,payment_id,ledger_id) VALUES ($1,$2,$3,$4)",
            [f.tenant.orgId, f.tenant.storeId, link.payment_id, link.ledger_id],
          );
        }),
      /duplicate key/u,
    );
    const unrelated = await f.order.appendPayment!({
      org_id: f.tenant.orgId,
      store_id: f.tenant.storeId,
      order_id: f.orderId,
      amount_cents: 1200,
      method: "cash",
      kind: "pay",
      staff_id: f.tenant.staffId,
      at: CANCEL_AT,
      business_date: CANCEL_DAY,
      note: null,
    });
    assert.ok(unrelated);
    await assert.rejects(
      () =>
        f.transaction(async (_store, tx) => {
          await tx.query(
            "INSERT INTO member_payment_links (org_id,store_id,payment_id,ledger_id) VALUES ($1,$2,$3,$4)",
            [f.tenant.orgId, f.tenant.storeId, unrelated.payment.payment_id, link.ledger_id],
          );
        }),
      /MEMBER_PAYMENT_LINK_MISMATCH/u,
    );
  } finally {
    await f.cleanup();
  }
});

maybe("PG historical migration links only exact, unambiguous payment audit identity", async () => {
  assert.ok(urls);
  const f = await createCancellationFixture(urls, 1000);
  try {
    await f.pay(1200);
    await f.pay(1200);
    const sql = await readFile(
      new URL(
        "../../../../packages/db/src/migrations/0083_member_payment_links.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const backfill = sql
      .slice(sql.indexOf("WITH candidates AS ("), sql.indexOf("-- A payment debit"))
      .replace("WHERE audit.command =", "WHERE audit.org_id = $1::uuid AND audit.command =");
    const evidence = await f.adminPool.query<{ ledger_id: string; payment_id: string }>(
      "SELECT ledger_id,payment_id FROM member_payment_links WHERE org_id=$1 ORDER BY ledger_id",
      [f.tenant.orgId],
    );
    const [first, second] = evidence.rows;
    assert.ok(first && second);
    const ambiguousAudit = randomUUID();
    await f.adminPool.query(
      `INSERT INTO audit_log (id,org_id,store_id,staff_id,via,command,dry_run,entity,entity_id,after_json,at)
      VALUES ($1,$2,$3,$4,'ui','member.balance.pay',false,'member_ledger',$5,$6,now())`,
      [
        ambiguousAudit,
        f.tenant.orgId,
        f.tenant.storeId,
        f.tenant.staffId,
        first.ledger_id,
        JSON.stringify({ payment_id: second.payment_id }),
      ],
    );
    await f.adminPool.query("DELETE FROM member_payment_links WHERE org_id=$1", [f.tenant.orgId]);
    await f.adminPool.query(backfill, [f.tenant.orgId]);
    assert.equal(
      (
        await f.adminPool.query("SELECT * FROM member_payment_links WHERE org_id=$1", [
          f.tenant.orgId,
        ])
      ).rows.length,
      0,
    );
    await assert.rejects(() => f.cancel());
    await f.adminPool.query("DELETE FROM audit_log WHERE id=$1", [ambiguousAudit]);
    await f.adminPool.query(backfill, [f.tenant.orgId]);
    assert.equal(
      (
        await f.adminPool.query("SELECT * FROM member_payment_links WHERE org_id=$1", [
          f.tenant.orgId,
        ])
      ).rows.length,
      2,
    );
    await f.cancel();
    assert.equal((await f.view())?.balance.total_cents, 11000);
  } finally {
    await f.cleanup();
  }
});

maybe(
  "PG another cancellation participant failure rolls back an already appended wallet return",
  async () => {
    assert.ok(urls);
    const f = await createCancellationFixture(urls, 1000);
    try {
      await f.pay(4200);
      await assert.rejects(
        () =>
          f.transaction(async () =>
            f.order.cancelOpenOrder!(
              f.tenant.orgId,
              f.tenant.storeId,
              f.orderId,
              "合成回滚",
              f.tenant.staffId,
              CANCEL_AT,
              CANCEL_DAY,
              async () => {
                throw new Error("Injected coupon return failure");
              },
            ),
          ),
        /Injected coupon/u,
      );
      assert.equal((await f.view())?.balance.total_cents, 6800);
      assert.equal((await f.payments()).length, 1);
      await f.cancel();
      assert.equal((await f.view())?.balance.total_cents, 11000);
    } finally {
      await f.cleanup();
    }
  },
);
