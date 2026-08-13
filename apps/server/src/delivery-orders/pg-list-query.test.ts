import assert from "node:assert/strict";
import test from "node:test";

import { deliveryOrderListQuery } from "./pg-list-query.js";

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";

test("PostgreSQL worklist stays parameterized and follows later canonical merges", () => {
  const query = deliveryOrderListQuery({
    customer_id: CUSTOMER_ID,
    laundry_order_id: ORDER_ID,
    status: "return_scheduled",
    limit: 50,
  });
  assert.match(
    query.sql,
    /customer_canonical_root\(customer_id\) = customer_canonical_root\(\$3::uuid\)/u,
  );
  assert.match(query.sql, /laundry_order_id = \$4::uuid/u);
  assert.match(query.sql, /status = \$5/u);
  assert.match(query.sql, /LIMIT \$6/u);
  assert.doesNotMatch(query.sql, new RegExp(CUSTOMER_ID, "u"));
  assert.deepEqual(query.values, [CUSTOMER_ID, ORDER_ID, "return_scheduled", 50]);
});
