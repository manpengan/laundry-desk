import assert from "node:assert/strict";
import test from "node:test";

import {
  OFFLINE_GRANT_ALLOWED_COMMANDS,
  PRIMARY_LEASE_ALLOWED_COMMANDS,
  grantCommandArgsAllowed,
  replayCommandAllowed,
  storedGrantAllowsCommand,
} from "./replay-policy.js";

test("keeps ordinary grant and Primary command allowlists exact and disjoint", () => {
  assert.deepEqual(OFFLINE_GRANT_ALLOWED_COMMANDS, [
    "order.receive",
    "order.hold",
    "customer.upsert",
    "print.ticket.enqueue",
    "print.ticket.retry",
    "print.ticket.reprint",
  ]);
  assert.deepEqual(PRIMARY_LEASE_ALLOWED_COMMANDS, [
    "order.pickup",
    "payment.collect",
    "payment.repay",
  ]);
  assert.equal(
    OFFLINE_GRANT_ALLOWED_COMMANDS.some((command) =>
      PRIMARY_LEASE_ALLOWED_COMMANDS.includes(command as never),
    ),
    false,
  );
  assert.equal(replayCommandAllowed("grant", "order.receive"), true);
  assert.equal(replayCommandAllowed("grant", "payment.collect"), false);
  assert.equal(replayCommandAllowed("primary_lease", "payment.collect"), true);
  assert.equal(replayCommandAllowed("primary_lease", "order.receive"), false);
});

test("ordinary order.receive permits only debt or cash", () => {
  assert.equal(grantCommandArgsAllowed("order.receive", { lines: [] }), true);
  assert.equal(
    grantCommandArgsAllowed("order.receive", {
      lines: [],
      initial_payment: { amount_cents: 100, method: "cash" },
    }),
    true,
  );
  for (const method of ["wechat", "alipay", "other", "balance"]) {
    assert.equal(
      grantCommandArgsAllowed("order.receive", {
        lines: [],
        initial_payment: { amount_cents: 100, method },
      }),
      false,
    );
  }
  assert.equal(grantCommandArgsAllowed("order.hold", {}), true);
});

test("Primary commands are independent from the signed six-command grant list", () => {
  assert.equal(
    storedGrantAllowsCommand("primary_lease", OFFLINE_GRANT_ALLOWED_COMMANDS, "payment.collect"),
    true,
  );
  assert.equal(
    storedGrantAllowsCommand("grant", OFFLINE_GRANT_ALLOWED_COMMANDS, "order.receive"),
    true,
  );
  assert.equal(
    storedGrantAllowsCommand("grant", OFFLINE_GRANT_ALLOWED_COMMANDS, "payment.collect"),
    false,
  );
});
