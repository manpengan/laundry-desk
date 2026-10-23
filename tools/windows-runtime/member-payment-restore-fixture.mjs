import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

async function readMemberPayment(client, ids) {
  const link = await client.query(
    "SELECT org_id,store_id,payment_id,ledger_id FROM member_payment_links WHERE payment_id=$1",
    [ids.payment],
  );
  const ledger = await client.query(
    "SELECT * FROM member_ledger WHERE account_id=$1 ORDER BY ledger_seq",
    [ids.account],
  );
  const payments = await client.query("SELECT * FROM payments WHERE order_id=$1 ORDER BY kind", [
    ids.order,
  ]);
  return { link: link.rows, ledger: ledger.rows, payments: payments.rows };
}

export async function seedMemberPayment(client, { org, store, staff }) {
  const ids = Object.fromEntries(
    ["customer", "account", "rule", "order", "topup", "debit", "credit", "payment", "reversal"].map(
      (name) => [name, randomUUID()],
    ),
  );
  await client.query(
    "INSERT INTO customers(id,org_id,phone,name,created_at,updated_at) VALUES($1,$2,'13800000008','Synthetic member',now(),now())",
    [ids.customer, org],
  );
  await client.query(
    "INSERT INTO member_accounts(id,org_id,customer_id,opened_at,opened_store_id) VALUES($1,$2,$3,now(),$4)",
    [ids.account, org, ids.customer, store],
  );
  await client.query(
    "INSERT INTO member_bonus_rules(id,org_id,min_topup_cents,bonus_cents,status,effective_from,updated_at,updated_by_staff_id) VALUES($1,$2,10000,2000,'active',now(),now(),$3)",
    [ids.rule, org, staff],
  );
  await client.query(
    "INSERT INTO orders(id,org_id,store_id,ticket_no,pickup_code,status,customer_id,subtotal_cents,original_cents,payable_cents,paid_cents,balance_cents,created_at,updated_at,created_by_staff_id,business_date) VALUES($1::uuid,$2,$3,$1::uuid::text,'888888','cancelled',$4,4200,4200,4200,0,0,now(),now(),$5,'2026-10-23')",
    [ids.order, org, store, ids.customer, staff],
  );
  await client.query(
    "INSERT INTO member_ledger(id,org_id,store_id,account_id,kind,principal_delta_cents,bonus_delta_cents,order_id,ref_ledger_id,staff_id,at,business_date,tender,bonus_rule_id) VALUES($1,$4,$5,$6,'topup',10000,2000,NULL,NULL,$8,now(),'2026-10-23','cash',$9),($2,$4,$5,$6,'pay',-3500,-700,$7,NULL,$8,now(),'2026-10-23',NULL,NULL),($3,$4,$5,$6,'reversal',3500,700,$7,$2,$8,now(),'2026-10-23',NULL,NULL)",
    [ids.topup, ids.debit, ids.credit, org, store, ids.account, ids.order, staff, ids.rule],
  );
  await client.query(
    "INSERT INTO payments(id,org_id,store_id,order_id,method,amount_cents,kind,ref_payment_id,staff_id,at,business_date) VALUES($1,$3,$4,$5,'balance',4200,'pay',NULL,$6,now(),'2026-10-23'),($2,$3,$4,$5,'balance',4200,'reversal',$1,$6,now(),'2026-10-23')",
    [ids.payment, ids.reversal, org, store, ids.order, staff],
  );
  await client.query(
    "INSERT INTO member_payment_links(org_id,store_id,payment_id,ledger_id) VALUES($1,$2,$3,$4)",
    [org, store, ids.payment, ids.debit],
  );
  const expected = await readMemberPayment(client, ids);
  assert.deepEqual(expected.link, [
    { org_id: org, store_id: store, payment_id: ids.payment, ledger_id: ids.debit },
  ]);
  assert.deepEqual(
    expected.ledger.map((row) => [
      row.id,
      row.principal_delta_cents,
      row.bonus_delta_cents,
      row.ref_ledger_id,
    ]),
    [
      [ids.topup, "10000", "2000", null],
      [ids.debit, "-3500", "-700", null],
      [ids.credit, "3500", "700", ids.debit],
    ],
  );
  assert.deepEqual(
    expected.payments.map((row) => [row.id, row.amount_cents, row.ref_payment_id]),
    [
      [ids.payment, 4200, null],
      [ids.reversal, 4200, ids.payment],
    ],
  );
  return { ids, expected };
}

export async function assertMemberPaymentPreserved(client, fixture) {
  assert.deepEqual(await readMemberPayment(client, fixture.ids), fixture.expected);
}
