import assert from "node:assert/strict";
import test from "node:test";
import { createCommandError } from "@laundry/contracts";
import { createHttpCommandClient } from "./command-client.js";

for (const scenario of [
  {
    command: "order.cancel",
    code: "INVARIANT_FAILED",
    reason: "member_account_closed",
    message: "原付款会员账户已关闭，无法原路退回储值。请联系店长核对退卡与订单结算，撤单尚未执行",
  },
  {
    command: "order.cancel",
    code: "INVARIANT_FAILED",
    reason: "member_payment_unlinked",
    message: "无法核实原储值付款与会员分录的对应关系。请联系店长核对会员账本，撤单尚未执行",
  },
  {
    command: "member.asset.consume",
    code: "INVARIANT_FAILED",
    reason: "coupon_payment_history",
    message: "该订单已有收退款记录，不能再使用优惠券；原订单和优惠券均未改变",
  },
  {
    command: "shift.close",
    code: "VALIDATION_FAILED",
    reason: "future_business_date",
    message: "不能提前交班，请选择今天或更早的门店营业日",
  },
] as const) {
  test(`HTTP command renders actionable ${scenario.reason} without losing the server reason`, async () => {
    const failure = createCommandError(scenario.code, { kind: "reason", reason: scenario.reason });
    let requests = 0;
    const client = createHttpCommandClient({
      apiBaseUrl: "http://127.0.0.1:8787",
      getAccessToken: () => "synthetic-token",
      readCsrf: () => "synthetic-csrf",
      fetchImpl: async () => {
        requests += 1;
        return new Response(JSON.stringify({ ok: false, error: failure }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const result = await client.execute(scenario.command, {});
    assert.equal(result.ok, false);
    if (result.ok) assert.fail("server refusal became success");
    assert.equal(result.error.code, scenario.code);
    assert.equal(result.error.message, scenario.message);
    assert.deepEqual(result.error.detail, { kind: "reason", reason: scenario.reason });
    assert.equal(requests, 1, "definitive refusal must not retry automatically");
  });
}
