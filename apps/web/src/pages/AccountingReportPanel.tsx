import { Button, Dialog, Input, MoneyText, useToast } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { unwrapQueryResult } from "./customer-model.js";
import { downloadAccountingExport } from "./accounting-report-export.js";
import {
  accountingRangeError,
  monthRange,
  parseAccountingExport,
  parseAccountingReport,
  type AccountingReportView,
} from "./accounting-report-model.js";
import { AccountingReportView as AccountingReportResultView } from "./AccountingReportView.js";

type ReportMode = "today" | "history" | "month" | "staff";
type ReportBody = Readonly<{
  date_from?: string;
  date_to?: string;
  group_by: "day" | "staff";
}>;
type PendingExport = Readonly<{ confirmRef: string; report: AccountingReportView }>;

export type AccountingReportPanelProps = Readonly<{
  queryClient: QueryPort;
  commandClient?: CommandPort;
  autoLoad?: boolean;
}>;

function selectionBody(
  mode: ReportMode,
  dateFrom: string,
  dateTo: string,
  month: string,
): Readonly<{ body: ReportBody | null; error: string | null }> {
  if (mode === "today") {
    return Object.freeze({ body: { group_by: "day" as const }, error: null });
  }
  if (mode === "month") {
    const range = monthRange(month);
    return range === null
      ? Object.freeze({ body: null, error: "请选择结算月份" })
      : Object.freeze({
          body: {
            date_from: range.dateFrom,
            date_to: range.dateTo,
            group_by: "day" as const,
          },
          error: null,
        });
  }
  const error = accountingRangeError(dateFrom, dateTo);
  return Object.freeze({
    body:
      error === null
        ? {
            date_from: dateFrom,
            date_to: dateTo,
            group_by: mode === "staff" ? ("staff" as const) : ("day" as const),
          }
        : null,
    error,
  });
}

export function accountingExportBody(report: AccountingReportView) {
  return Object.freeze({
    date_from: report.date_from,
    date_to: report.date_to,
    group_by: report.group_by,
    ...(report.staff_id === null ? {} : { staff_id: report.staff_id }),
    format: "csv" as const,
  });
}

export function requestAccountingExport(commandClient: CommandPort, report: AccountingReportView) {
  return commandClient.execute<unknown>("accounting.report.export", accountingExportBody(report));
}

export function resumeAccountingExport(commandClient: CommandPort, confirmRef: string) {
  return commandClient.execute<unknown>("accounting.report.export", {}, { confirmRef });
}

export function AccountingReportPanel({
  queryClient,
  commandClient,
  autoLoad = true,
}: AccountingReportPanelProps) {
  const toast = useToast();
  const [mode, setMode] = useState<ReportMode>("today");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [month, setMonth] = useState("");
  const [report, setReport] = useState<AccountingReportView | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [pending, setPending] = useState<PendingExport | null>(null);
  const loadRef = useRef<() => Promise<void>>(async () => undefined);

  const load = useCallback(async () => {
    const selection = selectionBody(mode, dateFrom, dateTo, month);
    if (selection.body === null) {
      toast.push(selection.error ?? "报表条件无效", "error");
      return;
    }
    setBusy(true);
    setReport(null);
    setPending(null);
    try {
      const result = await queryClient.execute<unknown>("accounting.report.get", selection.body);
      if (!result.ok) {
        toast.push(result.error.message ?? result.error.code, "error");
        return;
      }
      const parsed = parseAccountingReport(unwrapQueryResult(result.data));
      if (parsed === null) {
        toast.push("账目报表无法解析", "error");
        return;
      }
      setReport(parsed);
    } finally {
      setBusy(false);
    }
  }, [dateFrom, dateTo, mode, month, queryClient, toast]);

  loadRef.current = load;
  useEffect(() => {
    if (autoLoad) void loadRef.current();
  }, [autoLoad]);

  const finishExport = useCallback(
    async (data: unknown) => {
      const exported = parseAccountingExport(unwrapQueryResult(data));
      if (exported === null || !(await downloadAccountingExport(exported))) {
        toast.push("账目 CSV 完整性校验失败", "error");
        return;
      }
      toast.push("账目 CSV 已完成完整性校验", "success");
    },
    [toast],
  );

  const exportReport = useCallback(async () => {
    if (commandClient === undefined || report === null) return;
    setExporting(true);
    try {
      const result = await requestAccountingExport(commandClient, report);
      if (result.ok) {
        await finishExport(result.data);
        return;
      }
      if (isStepUpRequired(result) && result.error.code === "POLICY_CONFIRMATION_REQUIRED") {
        setPending(Object.freeze({ confirmRef: result.error.detail.confirm_ref, report }));
        return;
      }
      toast.push(result.error.message ?? result.error.code, "error");
    } finally {
      setExporting(false);
    }
  }, [commandClient, finishExport, report, toast]);

  const confirmExport = useCallback(async () => {
    if (commandClient === undefined || pending === null) return;
    setExporting(true);
    try {
      const result = await resumeAccountingExport(commandClient, pending.confirmRef);
      if (!result.ok) {
        toast.push(result.error.message ?? result.error.code, "error");
        return;
      }
      setPending(null);
      await finishExport(result.data);
    } finally {
      setExporting(false);
    }
  }, [commandClient, finishExport, pending, toast]);

  return (
    <section className="ld-accounting" data-testid="accounting-report-panel">
      <header className="ld-accounting__header">
        <div>
          <h2>经营账目</h2>
          <p>实收看现金流；业绩看洗护消费。充值本金只进实收，会员余额消费只进业绩。</p>
        </div>
      </header>

      <div className="ld-accounting__filters">
        <label className="ld-field">
          <span className="ld-field__label">报表类型</span>
          <select
            className="ld-input"
            value={mode}
            onChange={(event) => {
              setMode(event.target.value as ReportMode);
              setReport(null);
              setPending(null);
            }}
            disabled={busy}
            data-testid="accounting-mode"
          >
            <option value="today">今日账目</option>
            <option value="history">往日 / 日期范围</option>
            <option value="month">月结</option>
            <option value="staff">职员业绩</option>
          </select>
        </label>
        {mode === "month" ? (
          <Input
            name="accounting-month"
            label="结算月份"
            type="month"
            value={month}
            onChange={(event) => setMonth(event.target.value)}
            disabled={busy}
            data-testid="accounting-month"
          />
        ) : mode === "today" ? null : (
          <>
            <Input
              name="accounting-date-from"
              label="开始日期"
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
              disabled={busy}
              data-testid="accounting-date-from"
            />
            <Input
              name="accounting-date-to"
              label="结束日期"
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
              disabled={busy}
              data-testid="accounting-date-to"
            />
          </>
        )}
        <div className="ld-accounting__actions">
          <Button
            variant="primary"
            onClick={() => void load()}
            disabled={busy}
            data-testid="accounting-load"
          >
            {busy ? "加载中…" : "生成报表"}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void exportReport()}
            disabled={busy || exporting || report === null || commandClient === undefined}
            data-testid="accounting-export"
          >
            {exporting ? "校验导出中…" : "导出账目 CSV"}
          </Button>
        </div>
      </div>

      {report === null ? null : <AccountingReportResultView report={report} />}

      <Dialog
        open={pending !== null}
        title="确认导出账目报表"
        onClose={() => {
          if (!exporting) setPending(null);
        }}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)} disabled={exporting}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void confirmExport()} disabled={exporting}>
              {exporting ? "导出中…" : "确认导出"}
            </Button>
          </>
        }
      >
        {pending === null ? null : (
          <div className="ld-accounting__confirmation">
            <p>
              营业日 {pending.report.date_from} 至 {pending.report.date_to}，按
              {pending.report.group_by === "staff" ? "职员" : "营业日"}汇总，共
              {pending.report.rows.length} 行。
            </p>
            <p>
              实收 <MoneyText fen={pending.report.totals.real_income_cents} size="sm" />
            </p>
            <p>
              业绩 <MoneyText fen={pending.report.totals.performance_income_cents} size="sm" />
            </p>
            <p>导出文件将做 SHA-256 完整性校验；审计仅保存筛选、行数和摘要。</p>
          </div>
        )}
      </Dialog>
    </section>
  );
}
