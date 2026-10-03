import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export async function seedMiniappNotifications(client, { org, store, staff }) {
  const customer = randomUUID(),
    binding = randomUUID(),
    session = randomUUID();
  await client.query(
    "INSERT INTO customers(id,org_id,phone,name,created_at,updated_at) VALUES($1,$2,'13800000009','Synthetic',now(),now())",
    [customer, org],
  );
  await client.query(
    "INSERT INTO miniapp_bindings(id,org_id,store_id,app_id,openid_sha256,encrypted_openid_json,customer_id) VALUES($1,$2,$3,'wx0123456789abcdef',$4,'{}',$5)",
    [binding, org, store, "a".repeat(64), customer],
  );
  await client.query(
    "INSERT INTO miniapp_sessions(id,org_id,store_id,binding_id,customer_id,config_version,expires_at) VALUES($1,$2,$3,$4,$5,1,statement_timestamp()+interval '10 minutes')",
    [session, org, store, binding, customer],
  );
  await client.query(
    "INSERT INTO miniapp_notification_settings(org_id,store_id,version,enabled,template_id,ticket_field,store_field,status_field,miniprogram_state,updated_by) VALUES($1,$2,1,true,'fixture','character_string1','thing2','phrase3','trial',$3)",
    [org, store, staff],
  );
  const records = [];
  for (const state of [
    "queued",
    "sending",
    "unknown",
    "accepted",
    "failed",
    "cancelled",
    "needs_review",
  ]) {
    const id = randomUUID(),
      consent = randomUUID(),
      order = randomUUID();
    await client.query(
      "INSERT INTO orders(id,org_id,store_id,ticket_no,pickup_code,status,customer_id,subtotal_cents,original_cents,payable_cents,paid_cents,balance_cents,created_at,updated_at,created_by_staff_id,business_date) VALUES($1::uuid,$2,$3,$1::uuid::text,$6,'open',$4,100,100,100,0,100,now(),now(),$5,'2026-10-03')",
      [order, org, store, customer, staff, String(123456 + records.length)],
    );
    await client.query(
      "INSERT INTO miniapp_subscriptions(id,org_id,store_id,customer_id,session_id,template_id) VALUES($1,$2,$3,$4,$5,'fixture')",
      [consent, org, store, customer, session],
    );
    await client.query(
      "INSERT INTO miniapp_notification_outbox(id,org_id,store_id,order_id,customer_id,binding_id,consent_id,created_by,settings_version,miniapp_version,template_id,payload_json,preview_sha256,state,dispatched_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,1,'fixture','{}',$9,$10,CASE WHEN $10='queued' THEN NULL ELSE statement_timestamp() END)",
      [id, org, store, order, customer, binding, consent, staff, "b".repeat(64), state],
    );
    await client.query(
      "UPDATE miniapp_subscriptions SET consumed_at=statement_timestamp(),outbox_id=$2 WHERE id=$1",
      [consent, id],
    );
    records.push(
      (
        await client.query(
          "SELECT o.id,o.state,o.dispatched_at,s.id AS consent,s.consumed_at,s.outbox_id FROM miniapp_notification_outbox o JOIN miniapp_subscriptions s ON s.id=o.consent_id WHERE o.id=$1",
          [id],
        )
      ).rows[0],
    );
  }
  const unused = randomUUID();
  await client.query(
    "INSERT INTO miniapp_subscriptions(id,org_id,store_id,customer_id,session_id,template_id,revoked_at) VALUES($1,$2,$3,$4,$5,'fixture','2026-10-01')",
    [unused, org, store, customer, session],
  );
  return records;
}

export async function assertMiniappNotificationsRevoked(client, records) {
  const setting = (await client.query("SELECT version,enabled FROM miniapp_notification_settings"))
    .rows[0];
  assert.deepEqual(setting, { version: 2, enabled: false });
  const subscriptions = (await client.query("SELECT * FROM miniapp_subscriptions")).rows;
  assert.equal(subscriptions.length, records.length + 1);
  for (const subscription of subscriptions) assert.ok(subscription.revoked_at);
  const unused = subscriptions.find((row) => row.outbox_id === null);
  assert.equal(unused.consumed_at, null);
  assert.equal(unused.revoked_at.toISOString(), "2026-10-01T00:00:00.000Z");
  for (const before of records) {
    const after = (
      await client.query(
        "SELECT state,dispatched_at,checked_at,error_code FROM miniapp_notification_outbox WHERE id=$1",
        [before.id],
      )
    ).rows[0];
    const consent = subscriptions.find((row) => row.id === before.consent);
    assert.deepEqual(consent.consumed_at, before.consumed_at);
    assert.equal(consent.outbox_id, before.outbox_id);
    assert.deepEqual(after.dispatched_at, before.dispatched_at);
    if (["queued", "sending", "unknown"].includes(before.state)) {
      assert.equal(after.state, "needs_review");
      assert.equal(after.error_code, "RESTORED_NO_REDISPATCH");
      assert.ok(after.checked_at);
    } else assert.equal(after.state, before.state);
  }
  await assert.rejects(
    client.query("UPDATE miniapp_notification_outbox SET state='queued' WHERE id=$1", [
      records[0].id,
    ]),
    { code: "42501" },
  );
  await assert.rejects(
    client.query("UPDATE miniapp_subscriptions SET consumed_at=NULL,outbox_id=NULL WHERE id=$1", [
      records[0].consent,
    ]),
    { code: "42501" },
  );
}
