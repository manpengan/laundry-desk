import assert from "node:assert/strict";
import test from "node:test";
import { COUNTER_NAV } from "../nav.js";
import { pageCopy } from "./page-copy.js";

test("every nav item has empty-state copy under 14+ chars description", () => {
  for (const item of COUNTER_NAV) {
    const c = pageCopy(item.id);
    assert.ok(c.title.length > 0);
    assert.ok(c.emptyTitle.length > 0);
    assert.ok(c.emptyDescription.length > 8);
    assert.ok(c.actionLabel.length > 0);
    assert.ok(c.actionLabel.length <= 14, c.actionLabel);
  }
});
