/**
 * 经营概览、交班与历史报表对账；金额口径仍由服务器返回。
 */

import { Button, Input, useToast } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import type { OfflinePort } from "../host/offline-port.js";
import { AccountingReportPanel } from "./AccountingReportPanel.js";
import { OfflineConflictPanel } from "./OfflineConflictPanel.js";
import { downloadReconciliationExport } from "./reconciliation-export.js";
import {
  parseReconciliationExport,
  parseReconciliationView,
  type ReconciliationView,
} from "./reconciliation-view.js";
import { ReconciliationSnapshot } from "./ReconciliationSnapshot.js";
import { ShiftClosePanel } from "./ShiftClosePanel.js";
import { StatsSections } from "./StatsSections.js";
import { ShiftHistoryPanel } from "./ShiftHistoryPanel.js";

export type DaySummaryView = Readonly<{
  business_date: string;
  order_count: number;
  garment_count: number;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  payment_cents: number;
  picked_garment_count: number;
  /** ADR-91 P1-5: the 账目 report's net receipts and sales for the same day. */
  real_income_cents?: number;
  performance_income_cents?: number;
}>;

export type StatsPageProps = {
  queryClient: QueryPort;
  /** Optional command bus for shift.close 交班. */
  commandClient?: CommandPort;
  /** Optional: manager step-up for POLICY_STEP_UP_REQUIRED on shift.close. */
  session?: SessionView;
  authClient?: AuthClient;
  /** Desktop-only local queue evidence and recovery actions. */
  offlinePort?: OfflinePort;
  /** Explicit business date override (tests or historic lookup). */
  defaultDate?: string;
  /** Skip auto-load on mount (tests). */
  autoLoad?: boolean;
};

/** Retained for historic-date entry tests; current day always comes from the server. */
export function utcYmd(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** Unwrap bus `{ execution, result }` or bare result. */
export function unwrapQueryResult(data: unknown): unknown {
  if (!isRecord(data)) return data;
  if ("result" in data) return data.result;
  return data;
}

export function parseDaySummary(value: unknown): DaySummaryView | null {
  if (!isRecord(value)) return null;
  if (typeof value.business_date !== "string") return null;
  const order_count = asInt(value.order_count);
  const garment_count = asInt(value.garment_count);
  const payable_cents = asInt(value.payable_cents);
  const paid_cents = asInt(value.paid_cents);
  const balance_cents = asInt(value.balance_cents);
  const payment_cents = asInt(value.payment_cents);
  const picked_garment_count = asInt(value.picked_garment_count);
  if (
    order_count === null ||
    garment_count === null ||
    payable_cents === null ||
    paid_cents === null ||
    balance_cents === null ||
    payment_cents === null ||
    picked_garment_count === null
  ) {
    return null;
  }
  const real_income_cents = asInt(value.real_income_cents);
  const performance_income_cents = asInt(value.performance_income_cents);
  return Object.freeze({
    business_date: value.business_date,
    order_count,
    garment_count,
    payable_cents,
    paid_cents,
    balance_cents,
    payment_cents,
    picked_garment_count,
    ...(real_income_cents === null || performance_income_cents === null
      ? {}
      : { real_income_cents, performance_income_cents }),
  });
}

export async function executeReconciliationExport(
  commandClient: CommandPort,
  businessDate: string,
) {
  let result = await commandClient.execute<unknown>("reconciliation.export", {
    business_date: businessDate,
    format: "csv",
  });
  if (isStepUpRequired(result) && result.error.code === "POLICY_CONFIRMATION_REQUIRED") {
    result = await commandClient.execute<unknown>(
      "reconciliation.export",
      {},
      { confirmRef: result.error.detail.confirm_ref },
    );
  }
  return result;
}

export function StatsPage({
  queryClient,
  commandClient,
  session,
  authClient,
  offlinePort,
  defaultDate,
  autoLoad = true,
}: StatsPageProps) {
  const toast = useToast();
  const [dateText, setDateText] = useState(() => defaultDate ?? "");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [snapshot, setSnapshot] = useState<ReconciliationView | null>(null);
  const loadRef = useRef<() => Promise<void>>(async () => undefined);
  const loadGenerationRef = useRef(0);

  const load = useCallback(async () => {
    const businessDate = dateText.trim();
    if (businessDate.length > 0 && !/^\d{4}-\d{2}-\d{2}$/u.test(businessDate)) {
      toast.push("请输入日期 YYYY-MM-DD", "error");
      return;
    }
    const loadGeneration = loadGenerationRef.current + 1;
    loadGenerationRef.current = loadGeneration;
    setSnapshot(null);
    setLoadError(null);
    setBusy(true);
    try {
      const res = await queryClient.execute<unknown>(
        "reconciliation.day.get",
        businessDate.length === 0 ? {} : { business_date: businessDate },
      );
      if (loadGeneration !== loadGenerationRef.current) return;
      if (!res.ok) {
        const message = res.error.message ?? res.error.code;
        setLoadError(message);
        toast.push(message, "error");
        setSnapshot(null);
        return;
      }
      const parsed = parseReconciliationView(unwrapQueryResult(res.data));
      if (loadGeneration !== loadGenerationRef.current) return;
      if (parsed === null) {
        setLoadError("对账快照无法解析");
        toast.push("对账快照无法解析", "error");
        setSnapshot(null);
        return;
      }
      setSnapshot(parsed);
      setDateText(parsed.business_date);
    } catch {
      if (loadGeneration === loadGenerationRef.current)
        setLoadError("对账加载失败，请检查连接后重试。");
    } finally {
      if (loadGeneration === loadGenerationRef.current) setBusy(false);
    }
  }, [dateText, queryClient, toast]);

  loadRef.current = load;

  useEffect(() => {
    if (!autoLoad) return;
    void loadRef.current();
    return () => {
      loadGenerationRef.current += 1;
    };
  }, [autoLoad]);

  const changeDate = useCallback((value: string) => {
    loadGenerationRef.current += 1;
    setBusy(false);
    setSnapshot(null);
    setLoadError(null);
    setDateText(value);
  }, []);

  return (
    <main className="ld-shell-main lg-card" id="main-content" tabIndex={-1}>
      <h1 className="ld-shell-main__title">账目 / 对账</h1>
      <p className="ld-shell-main__hint">
        统一核对订单、收付记录、交班、打印状态与离线补录；可查询历史营业日。
      </p>

      <StatsSections
        overview={
          <AccountingReportPanel
            queryClient={queryClient}
            autoLoad={autoLoad}
            allowedModes={["today"]}
            {...(commandClient === undefined ? {} : { commandClient })}
          />
        }
        reports={
          <>
            <AccountingReportPanel
              queryClient={queryClient}
              autoLoad={false}
              initialMode="history"
              allowedModes={["history", "month", "staff"]}
              {...(commandClient === undefined ? {} : { commandClient })}
            />
            <div className="ld-stats-form">
              <Input
                name="business-date"
                label="营业日"
                type="date"
                value={dateText}
                onChange={(event) => changeDate(event.target.value)}
                disabled={busy}
                data-testid="stats-date-input"
                hint="留空表示当前营业日"
              />
              <div className="ld-stats-form__actions">
                <Button
                  variant="primary"
                  type="button"
                  onClick={() => void load()}
                  disabled={busy}
                  data-testid="stats-load-btn"
                >
                  {busy ? "加载中…" : "查询对账"}
                </Button>
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => {
                    if (snapshot === null || commandClient === undefined) {
                      toast.push("请先查询对账快照", "error");
                      return;
                    }
                    void (async () => {
                      setExporting(true);
                      try {
                        const result = await executeReconciliationExport(
                          commandClient,
                          snapshot.business_date,
                        );
                        if (!result.ok) {
                          toast.push(result.error.message ?? result.error.code, "error");
                          return;
                        }
                        const exported = parseReconciliationExport(unwrapQueryResult(result.data));
                        if (exported === null || !(await downloadReconciliationExport(exported))) {
                          toast.push("对账导出校验失败", "error");
                          return;
                        }
                        toast.push("对账 CSV 已完成完整性校验", "success");
                      } catch {
                        toast.push("对账导出失败，请检查连接后重试。", "error");
                      } finally {
                        setExporting(false);
                      }
                    })();
                  }}
                  disabled={busy || exporting || snapshot === null || commandClient === undefined}
                  data-testid="stats-export-csv-btn"
                >
                  {exporting ? "校验导出中…" : "导出审计 CSV"}
                </Button>
              </div>
            </div>

            {loadError === null ? null : <p role="alert">{loadError}</p>}
            {snapshot === null ? null : <ReconciliationSnapshot value={snapshot} />}

            {offlinePort === undefined ? null : <OfflineConflictPanel offlinePort={offlinePort} />}
          </>
        }
        shift={
          <>
            <Input
              name="shift-business-date"
              label="交班营业日"
              type="date"
              value={dateText}
              onChange={(event) => changeDate(event.target.value)}
              disabled={busy}
              hint="按门店营业日核对交班；可选择日期查看记录。"
            />
            {commandClient !== undefined ? (
              <ShiftClosePanel
                queryClient={queryClient}
                commandClient={commandClient}
                businessDate={snapshot?.business_date ?? dateText}
                autoLoad={autoLoad}
                {...(session !== undefined ? { session } : {})}
                {...(authClient !== undefined ? { authClient } : {})}
              />
            ) : null}
            {dateText.length > 0 ? (
              <ShiftHistoryPanel queryClient={queryClient} initialDate={dateText} />
            ) : null}
            {commandClient === undefined ? (
              <p role="status">当前连接不支持交班操作，可查看已有交班记录。</p>
            ) : null}
          </>
        }
      />
    </main>
  );
}
