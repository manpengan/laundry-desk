import { Button, Input, MoneyText, useToast } from "@laundry/ui";
import { useCallback, useState } from "react";

import type { QueryPort } from "../commands/types.js";
import { downloadShiftHistoryCsv } from "./shift-history-csv.js";
import {
  parseShiftClosing,
  type ShiftClosingView,
  unwrapShiftResult,
} from "./shift-closing-view.js";

export type ShiftHistoryPanelProps = Readonly<{
  queryClient: QueryPort;
  initialDate: string;
}>;

function parseHistory(value: unknown): readonly ShiftClosingView[] | null {
  const result = unwrapShiftResult(value);
  if (typeof result !== "object" || result === null || !("shifts" in result)) return null;
  const shifts = (result as Readonly<{ shifts?: unknown }>).shifts;
  if (!Array.isArray(shifts)) return null;
  const parsed = shifts.map(parseShiftClosing);
  if (parsed.some((row) => row === null)) return null;
  return Object.freeze(parsed as ShiftClosingView[]);
}

export function ShiftHistoryPanel({ queryClient, initialDate }: ShiftHistoryPanelProps) {
  const toast = useToast();
  const [dateFrom, setDateFrom] = useState(initialDate);
  const [dateTo, setDateTo] = useState(initialDate);
  const [rows, setRows] = useState<readonly ShiftClosingView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (
      !/^\d{4}-\d{2}-\d{2}$/u.test(dateFrom) ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(dateTo) ||
      dateFrom > dateTo
    ) {
      toast.push("请选择有效的交班历史日期范围", "error");
      return;
    }
    setBusy(true);
    try {
      const result = await queryClient.execute<unknown>("shift.history", {
        date_from: dateFrom,
        date_to: dateTo,
        limit: 100,
      });
      if (!result.ok) {
        toast.push(result.error.message ?? result.error.code, "error");
        return;
      }
      const parsed = parseHistory(result.data);
      if (parsed === null) {
        toast.push("交班历史响应格式错误", "error");
        return;
      }
      setRows(parsed);
      setLoaded(true);
    } finally {
      setBusy(false);
    }
  }, [dateFrom, dateTo, queryClient, toast]);

  return (
    <section className="ld-shift-history" aria-label="交班历史">
      <header>
        <div>
          <h2>交班历史</h2>
          <p>历史快照不重算；现金差额按交班时已冻结账本展示。</p>
        </div>
        <div className="ld-shift-history__filters">
          <Input
            name="shift-history-from"
            label="开始营业日"
            type="date"
            value={dateFrom}
            onChange={(event) => setDateFrom(event.target.value)}
          />
          <Input
            name="shift-history-to"
            label="结束营业日"
            type="date"
            value={dateTo}
            onChange={(event) => setDateTo(event.target.value)}
          />
          <Button variant="secondary" type="button" onClick={() => void load()} disabled={busy}>
            查询历史
          </Button>
          <Button
            variant="ghost"
            type="button"
            disabled={!loaded || rows.length === 0}
            onClick={() => downloadShiftHistoryCsv(rows, dateFrom, dateTo)}
          >
            导出历史 CSV
          </Button>
        </div>
      </header>
      {loaded ? (
        <div className="ld-shift-history__table-wrap">
          <table>
            <thead>
              <tr>
                <th>营业日</th>
                <th>签字人</th>
                <th>订单</th>
                <th>收款流水</th>
                <th>应有现金</th>
                <th>实点现金</th>
                <th>差额</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.shift_id}>
                  <td>{row.business_date}</td>
                  <td>{row.signature_name ?? "—"}</td>
                  <td>{row.order_count}</td>
                  <td>
                    <MoneyText fen={row.payment_cents} size="sm" />
                  </td>
                  <td>
                    <MoneyText fen={row.expected_cash_cents ?? 0} size="sm" />
                  </td>
                  <td>
                    <MoneyText fen={row.counted_cash_cents} size="sm" />
                  </td>
                  <td>
                    <MoneyText fen={row.cash_difference_cents} size="sm" />
                  </td>
                  <td>{row.cash_difference_cents === 0 ? "已核对" : "有差异"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 ? <p>所选范围暂无交班记录。</p> : null}
        </div>
      ) : null}
    </section>
  );
}
