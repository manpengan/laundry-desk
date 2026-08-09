import assert from "node:assert/strict";
import test from "node:test";

import { PrintDispatchError } from "./dispatch-service.js";
import { derivePrintJobActionFromSource } from "./pg-print-dispatch.js";

const SOURCE_JOB_ID = "936da01f-9abd-4d9d-80c7-02af85c822a8";

test("print dispatch action is derived only from authoritative source lineage", () => {
  assert.equal(derivePrintJobActionFromSource(null, null), "enqueue");
  assert.equal(derivePrintJobActionFromSource(SOURCE_JOB_ID, "done"), "reprint");
  assert.equal(derivePrintJobActionFromSource(SOURCE_JOB_ID, "failed"), "retry");
  assert.equal(derivePrintJobActionFromSource(SOURCE_JOB_ID, "uncertain"), "retry");

  for (const [sourceJobId, status] of [
    [SOURCE_JOB_ID, "queued"],
    [SOURCE_JOB_ID, "printing"],
    [SOURCE_JOB_ID, null],
    [null, "done"],
  ] as const) {
    assert.throws(
      () => derivePrintJobActionFromSource(sourceJobId, status),
      (error: unknown) => error instanceof PrintDispatchError && error.code === "binding",
    );
  }
});
