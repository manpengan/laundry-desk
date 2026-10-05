import assert from "node:assert/strict";
import test from "node:test";
import { createCommandError } from "@laundry/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { createPaymentChannelPort } from "../host/payment-channel-port.js";
import { ReconciliationHistoryPanel } from "./ReconciliationHistoryPanel.js";
import { exportReconciliation, reconciliationCsv } from "./channel-reconciliation-export.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const id = "11111111-1111-4111-8111-111111111111";
const summary = {
  reconciliation_id: id,
  channel: "wechat",
  business_date: "2026-10-06",
  created_at: "2026-10-06T00:00:00.000Z",
  source_sha256: "a".repeat(64),
  matched_count: 8,
  mismatch_count: 151,
} as const;
const rows = Array.from({ length: 151 }, (_, index) => ({
  index,
  merchant_order: `LD-${index}`,
  merchant_refund: null,
  reason: "missing_local" as const,
  order_id: null,
  review: { state: "open" as const, note: "", version: 0, reviewed_at: null },
}));
function click(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root.findAllByType("button").find((n) => n.children.join("") === label);
  assert.ok(button, label);
  button.props.onClick();
}
test("a new reconciliation refreshes an already open history", async () => {
  let historyCalls = 0;
  const port = createPaymentChannelPort(async (input) => {
    if (input.operation === "reconcile.history") {
      historyCalls++;
      return {
        ok: true,
        data: {
          rows: historyCalls > 1 ? [summary] : [],
          total: historyCalls > 1 ? 1 : 0,
          offset: 0,
          limit: 25,
        },
      };
    }
    return { ok: false, error: createCommandError("RESOURCE_UNAVAILABLE") };
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ReconciliationHistoryPanel port={port} />);
  });
  try {
    await act(async () => click(renderer, "查看历史对账与复核"));
    assert.equal(historyCalls, 1);
    await act(async () =>
      renderer.update(<ReconciliationHistoryPanel port={port} latestId={id} />),
    );
    assert.equal(historyCalls, 2);
    assert.match(JSON.stringify(renderer.toJSON()), /151/u);
  } finally {
    await act(async () => renderer.unmount());
  }
});
test("historical reconciliation opens all pages beyond 100 and retains review note after a conflict", async () => {
  const offsets: number[] = [];
  const versions: number[] = [];
  const port = createPaymentChannelPort(async (input) => {
    if (input.operation === "reconcile.history")
      return { ok: true, data: { rows: [summary], total: 1, offset: 0, limit: 25 } };
    if (input.operation === "reconcile.detail") {
      offsets.push(input.body.offset);
      return {
        ok: true,
        data: {
          summary,
          rows: rows
            .slice(input.body.offset, input.body.offset + input.body.limit)
            .map((row) =>
              input.body.limit === 1
                ? { ...row, review: { ...row.review, version: 1, note: "另一位店长已核对" } }
                : row,
            ),
          offset: input.body.offset,
          limit: input.body.limit,
        },
      };
    }
    if (input.operation === "reconcile.review") versions.push(input.body.expected_version);
    return { ok: false, error: createCommandError("IDEMPOTENCY_CONFLICT") };
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ReconciliationHistoryPanel port={port} />);
  });
  try {
    await act(async () => click(renderer, "查看历史对账与复核"));
    const record = renderer.root
      .findAllByType("button")
      .find((n) => n.children.join("").includes("151"));
    assert.ok(record);
    await act(async () => record.props.onClick());
    await act(async () => click(renderer, "下一页差异"));
    await act(async () => click(renderer, "下一页差异"));
    assert.deepEqual(offsets, [0, 50, 100]);
    await act(async () => click(renderer, "复核第 101 条"));
    const note = renderer.root.findByType("textarea");
    await act(async () =>
      note.props.onChange({ target: { value: "已向收银员核对，等待渠道结果" } }),
    );
    await act(async () => click(renderer, "保存复核"));
    assert.match(JSON.stringify(renderer.toJSON()), /其他人已更新/u);
    assert.equal(renderer.root.findByType("textarea").props.value, "已向收银员核对，等待渠道结果");
    await act(async () => click(renderer, "读取最新复核（保留草稿）"));
    assert.match(JSON.stringify(renderer.toJSON()), /另一位店长已核对/u);
    assert.equal(renderer.root.findByType("textarea").props.value, "已向收银员核对，等待渠道结果");
    await act(async () => click(renderer, "保存复核"));
    assert.deepEqual(versions, [0, 1]);
  } finally {
    await act(async () => renderer.unmount());
  }
});
test("export fetches every difference and escapes spreadsheet formulas and quoted notes", async () => {
  const offsets: number[] = [];
  const port = createPaymentChannelPort(async (input) => {
    assert.equal(input.operation, "reconcile.detail");
    if (input.operation !== "reconcile.detail") throw new Error("unexpected");
    offsets.push(input.body.offset);
    return {
      ok: true,
      data: {
        summary,
        rows: rows.slice(input.body.offset, input.body.offset + input.body.limit),
        offset: input.body.offset,
        limit: input.body.limit,
      },
    };
  });
  const csv = await exportReconciliation(port, id);
  assert.deepEqual(offsets, [0, 100]);
  assert.match(csv, /LD-150/u);
  assert.equal(csv.split("\r\n").length, 152);
  assert.match(
    reconciliationCsv([
      { ...rows[0]!, review: { ...rows[0]!.review, note: '=HYPERLINK("evil")' } },
    ]),
    /'=HYPERLINK\(""evil""\)/u,
  );
});
