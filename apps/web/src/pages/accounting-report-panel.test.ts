import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";

import { createMockCommandClient } from "../commands/command-client.js";
import { createMockQueryClient } from "../commands/query-client.js";
import {
  AccountingReportPanel,
  requestAccountingExport,
  resumeAccountingExport,
} from "./AccountingReportPanel.js";
import type { AccountingReportView } from "./accounting-report-model.js";

const REPORT: AccountingReportView = Object.freeze({
  date_from: "2026-08-01",
  date_to: "2026-08-31",
  group_by: "staff",
  staff_id: null,
  generated_at: "2026-08-31T16:00:00.000Z",
  totals: Object.freeze({
    real_income_cents: 13_000,
    performance_income_cents: 8_000,
    order_cashflow_cents: 5_000,
    stored_value_cashflow_cents: 8_000,
    stored_value_consumption_cents: 3_000,
    ledger_row_count: 4,
  }),
  channels: Object.freeze([]),
  rows: Object.freeze([]),
});

test("accounting report SSR explains the two bases and exposes all presets", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(AccountingReportPanel, {
        queryClient: createMockQueryClient(),
        commandClient: createMockCommandClient(),
        autoLoad: false,
      }),
    ),
  );
  assert.match(html, /经营账目/);
  assert.match(html, /实收看现金流；业绩看洗护消费/);
  assert.match(html, /今日账目/);
  assert.match(html, /月结/);
  assert.match(html, /职员业绩/);
  assert.match(html, /data-testid="accounting-export"/);
});

test("accounting CSV export pauses for explicit R3 confirmation with frozen arguments", async () => {
  const calls: Readonly<{ body: unknown; confirmRef?: string }>[] = [];
  const confirmRef = "00000000-0000-4000-8000-000000000024";
  const commandClient = createMockCommandClient(
    async <T = unknown>(
      name: string,
      body: unknown = {},
      options?: Readonly<{ confirmRef?: string }>,
    ) => {
      assert.equal(name, "accounting.report.export");
      calls.push({
        body,
        ...(options?.confirmRef === undefined ? {} : { confirmRef: options.confirmRef }),
      });
      if (options?.confirmRef === undefined) {
        return Object.freeze({
          ok: false as const,
          error: Object.freeze({
            code: "POLICY_CONFIRMATION_REQUIRED",
            detail: Object.freeze({ kind: "confirmation", confirm_ref: confirmRef }),
          }),
        });
      }
      return Object.freeze({ ok: true as const, data: Object.freeze({ result: "ok" }) as T });
    },
  );

  const requested = await requestAccountingExport(commandClient, REPORT);
  assert.equal(requested.ok, false);
  if (requested.ok || requested.error.code !== "POLICY_CONFIRMATION_REQUIRED") return;
  assert.equal(requested.error.detail?.confirm_ref, confirmRef);

  const resumed = await resumeAccountingExport(commandClient, confirmRef);
  assert.equal(resumed.ok, true);
  assert.deepEqual(calls, [
    {
      body: {
        date_from: "2026-08-01",
        date_to: "2026-08-31",
        group_by: "staff",
        format: "csv",
      },
    },
    { body: {}, confirmRef },
  ]);
});
