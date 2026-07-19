import assert from "node:assert/strict";
import test from "node:test";

import { databaseTrustedClock } from "../src/trusted-clock.mjs";
import { createPool } from "./helpers.mjs";

const pool = createPool();

test.after(async () => pool.end());

test("default trusted time is read from PostgreSQL clock_timestamp", async () => {
  const client = await pool.connect();
  try {
    const before = await client.query("SELECT clock_timestamp() AS now");
    const observed = await databaseTrustedClock.now(client);
    const after = await client.query("SELECT clock_timestamp() AS now");

    assert.ok(observed.getTime() >= before.rows[0].now.getTime());
    assert.ok(observed.getTime() <= after.rows[0].now.getTime());
  } finally {
    client.release();
  }
});
