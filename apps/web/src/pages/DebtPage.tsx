/**
 * 工作台欠款催付骨架 — order.list { min_balance_cents: 1, limit: 50 }.
 */

import { Button, MoneyText, StatusBadge, formatMoneyFromFen, useToast } from "@laundry/ui";
import { useCallback, useState } from "react";
import type { QueryPort } from "../commands/types.js";
import { parseOrderListRows, unwrapQueryResult, type OrderListRowView } from "./OrdersList.js";
import { OrderDetailDrawer } from "./OrderDetailDrawer.js";

const DEBT_LIST_LIMIT = 50;
const DEBT_MIN_BALANCE_CENTS = 1;

export type DebtPageProps = {
  queryClient: QueryPort;
  /** Navigate to pickup with order id prefilled. */
  onOpenPickup?: (orderId: string) => void;
};

export type DebtReminderFields = Readonly<{
  ticket_no: string;
  customer_name: string | null;
  customer_phone: string | null;
  balance_cents: number;
}>;

/** Plain-text催付文案（SSR-safe pure helper；整数分经 formatMoneyFromFen）。 */
export function buildDebtReminderText(row: DebtReminderFields): string {
  const name =
    row.customer_name !== null && row.customer_name.length > 0 ? row.customer_name : "客户";
  const phone =
    row.customer_phone !== null && row.customer_phone.length > 0
      ? row.customer_phone
      : "（无手机号）";
  const money = formatMoneyFromFen(row.balance_cents);
  return `【洗衣店催付】您好，${name}（${phone}），订单 ${row.ticket_no} 尚欠 ${money}，请尽快到店结清，谢谢！`;
}

/** Clipboard write; no-op / false when navigator.clipboard unavailable (SSR). */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof globalThis.navigator === "undefined") return false;
  const clipboard = globalThis.navigator.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== "function") return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function DebtPage({ queryClient, onOpenPickup }: DebtPageProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<readonly OrderListRowView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [detailOrderId, setDetailOrderId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await queryClient.execute<unknown>("order.list", {
        min_balance_cents: DEBT_MIN_BALANCE_CENTS,
        limit: DEBT_LIST_LIMIT,
      });
      if (!res.ok) {
        toast.push(res.error.message ?? res.error.code, "error");
        setRows([]);
        setLoaded(true);
        return;
      }
      const parsed = parseOrderListRows(unwrapQueryResult(res.data));
      if (parsed === null) {
        toast.push("欠款列表无法解析", "error");
        setRows([]);
        setLoaded(true);
        return;
      }
      setRows(parsed);
      setLoaded(true);
    } finally {
      setBusy(false);
    }
  }, [queryClient, toast]);

  const onCopyReminder = useCallback(
    async (row: OrderListRowView) => {
      const text = buildDebtReminderText(row);
      const ok = await copyTextToClipboard(text);
      if (ok) {
        toast.push("催付文案已复制", "success");
      } else {
        toast.push("无法复制到剪贴板", "error");
      }
    },
    [toast],
  );

  return (
    <section className="ld-debt" data-testid="debt-section" aria-label="欠款">
      <h2 className="ld-orders__title">欠款</h2>
      <p className="ld-orders__hint">
        余额 ≥ 1 分的应收订单（全日期，最多 {DEBT_LIST_LIMIT}{" "}
        条）。可打开详情/取衣，或生成催付文案。
      </p>

      <div className="ld-orders-form">
        <div className="ld-orders-form__actions">
          <Button
            variant="primary"
            type="button"
            onClick={() => void load()}
            disabled={busy}
            data-testid="debt-load-btn"
          >
            {busy ? "加载中…" : loaded ? "刷新欠款" : "加载欠款"}
          </Button>
        </div>
      </div>

      <ul className="ld-orders-list" data-testid="debt-list">
        {!loaded ? (
          <li className="ld-orders-list__empty">点击「加载欠款」查看应收</li>
        ) : rows.length === 0 ? (
          <li className="ld-orders-list__empty">暂无欠款订单</li>
        ) : (
          rows.map((row) => (
            <li key={row.order_id} className="ld-orders-list__row" data-testid="debt-row">
              <div className="ld-debt-row">
                <button
                  type="button"
                  className="ld-orders-list__btn ld-debt-row__main"
                  onClick={() => setDetailOrderId(row.order_id)}
                  data-testid="debt-row-detail-btn"
                >
                  <div className="ld-orders-list__main">
                    <span className="ld-orders-list__ticket">{row.ticket_no}</span>
                    <StatusBadge family="order" status={row.status} />
                  </div>
                  <div className="ld-orders-list__meta">
                    <span className="ld-orders-list__name">{row.customer_name ?? "—"}</span>
                    <span className="ld-orders-list__phone ld-orders-phone-internal">
                      {row.customer_phone ?? "—"}
                    </span>
                  </div>
                  <div className="ld-orders-list__money">
                    <span className="ld-orders-list__money-label">欠款</span>
                    <MoneyText fen={row.balance_cents} size="sm" />
                  </div>
                </button>
                <div className="ld-debt-row__actions">
                  {onOpenPickup !== undefined ? (
                    <Button
                      variant="ghost"
                      type="button"
                      size="sm"
                      onClick={() => onOpenPickup(row.order_id)}
                      data-testid="debt-row-pickup-btn"
                    >
                      取衣
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    type="button"
                    size="sm"
                    onClick={() => void onCopyReminder(row)}
                    data-testid="debt-row-copy-btn"
                  >
                    生成催付文案
                  </Button>
                </div>
              </div>
            </li>
          ))
        )}
      </ul>

      <OrderDetailDrawer
        open={detailOrderId !== null}
        orderId={detailOrderId}
        queryClient={queryClient}
        onClose={() => setDetailOrderId(null)}
        {...(onOpenPickup !== undefined
          ? {
              onPickup: (id: string) => {
                setDetailOrderId(null);
                onOpenPickup(id);
              },
            }
          : {})}
      />
    </section>
  );
}
