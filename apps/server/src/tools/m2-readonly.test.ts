import assert from "node:assert/strict";
import test from "node:test";

import { listTools } from "./list-tools.js";

test("M2 AI tool projection exposes only frozen read queries at R0-R2", () => {
  const tools = listTools({ preset: "counter_readonly", maxRisk: "R2" });
  assert.ok(tools.length > 0);
  for (const tool of tools) {
    assert.equal(tool.kind, "query");
    assert.ok(["R0", "R1", "R2"].includes(tool.risk));
    assert.equal(tool.name.includes("cancel"), false);
    assert.equal(tool.name.includes("payment."), false);
    assert.equal(tool.name.includes("settings.set"), false);
  }
  assert.ok(tools.some((tool) => tool.name === "order.list"));
  assert.ok(tools.some((tool) => tool.name === "stats.day.summary"));
});
