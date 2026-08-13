import assert from "node:assert/strict";
import test from "node:test";

import { prepareGroupBuyCode } from "./group-buy-code.js";

test("group-buy code preparation validates locally and emits only the domain-separated digest", async () => {
  assert.equal(await prepareGroupBuyCode("too-short"), null);
  assert.equal(await prepareGroupBuyCode("ABCD2345EFGH6789JKLM-234"), null);

  const prepared = await prepareGroupBuyCode("  ABCD2345EFGH6789JKLM2345  ");
  assert.deepEqual(prepared, {
    digest: "99ef2bdf6c936388ba04add1edf792d7331e4c513efdd45d67e75b7c2bfa2301",
    last4: "2345",
  });
  assert.doesNotMatch(JSON.stringify(prepared), /ABCD2345/u);
});
