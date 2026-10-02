/**
 * 工作台欠款催付骨架 — order.list { min_balance_cents: 1, limit: 50 }.
 */

import {
  Button,
  Icon,
  MoneyText,
  StatusBadge,
  formatMoneyFromFen,
  maskPhone,
  useToast,
} from "@laundry/ui";
import { useCallback, useEffect, useState } from "react";
import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import type { PhotoPort } from "../host/photo-port.js";
import { parseOrderListRows, unwrapQueryResult, type OrderListRowView } from "./OrdersList.js";
import { OrderDetailDrawer } from "./OrderDetailDrawer.js";

const DEBT_LIST_LIMIT = 50;
const DEBT_MIN_BALANCE_CENTS = 1;

export type DebtPageProps = {
  queryClient: QueryPort;
  /** Without this the detail drawer can display but not collect or cancel. */
  commandClient?: CommandPort;
  authClient?: AuthClient;
  session?: SessionView;
  photoPort?: PhotoPort;
  memberEnabled?: boolean;
  /** Navigate to pickup with order id prefilled. */
  onOpenPickup?: (orderId: string) => void;
};

export type DebtReminderFields = Readonly<{
  ticket_no: string | null;
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
  return `【洗衣店催付】您好，${name}（${phone}），订单 ${row.ticket_no ?? "挂单"} 尚欠 ${money}，请尽快到店结清，谢谢！`;
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

export function DebtPage({
  queryClient,
  commandClient,
  authClient,
  session,
  photoPort,
  memberEnabled = false,
  onOpenPickup,
}: DebtPageProps) {
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

  // The workbench already shows an outstanding-balance total, so the data is
  // ready by the time this page opens; make the operator click only to refresh.
  useEffect(() => {
    void load();
  }, [load]);

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
    <main className="ld-shell-main ld-debt-page" id="main-content" tabIndex={-1}>
      <h1 className="ld-shell-main__title">订单与欠款</h1>
      <p className="ld-shell-main__hint">
        仍有欠款的订单（全部日期，最多 {DEBT_LIST_LIMIT} 条）。点击订单查看详情、补缴或退款。
      </p>
      <section className="ld-section ld-debt" data-testid="debt-section" aria-label="欠款">
        <div className="ld-section__head">
          <h2 className="ld-section__title">
            欠款
            {loaded ? <span className="ld-section__count">{rows.length}</span> : null}
          </h2>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => void load()}
            disabled={busy}
            data-testid="debt-load-btn"
          >
            <Icon name="refresh" size={16} />
            {busy ? "加载中…" : loaded ? "刷新欠款" : "加载欠款"}
          </Button>
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
                      <span
                        className={
                          row.ticket_no === null
                            ? "ld-orders-list__ticket ld-orders-list__ticket--none"
                            : "ld-orders-list__ticket"
                        }
                      >
                        {row.ticket_no ?? "未出票"}
                      </span>
                      <StatusBadge family="order" status={row.status} />
                    </div>
                    <div className="ld-orders-list__meta">
                      <span className="ld-orders-list__name">{row.customer_name ?? "散客"}</span>
                      <span className="ld-orders-list__phone ld-orders-phone-internal">
                        {row.customer_phone === null ? "—" : maskPhone(row.customer_phone)}
                      </span>
                    </div>
                    <div className="ld-orders-list__money">
                      <span className="ld-orders-list__money-label">欠款</span>
                      <MoneyText fen={row.balance_cents} size="sm" />
                    </div>
                  </button>
                  <div className="ld-debt-row__actions">
                    {/* A 挂单 has no garments to hand over yet. */}
                    {onOpenPickup !== undefined && row.status !== "draft" ? (
                      <Button
                        variant="secondary"
                        type="button"
                        size="sm"
                        onClick={() => onOpenPickup(row.order_id)}
                        data-testid="debt-row-pickup-btn"
                      >
                        <Icon name="pickup" size={16} />
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
                      <Icon name="phone" size={16} />
                      生成催付文案
                    </Button>
                  </div>
                </div>
              </li>
            ))
          )}
        </ul>
      </section>

      <OrderDetailDrawer
        open={detailOrderId !== null}
        orderId={detailOrderId}
        queryClient={queryClient}
        memberEnabled={memberEnabled}
        {...(commandClient === undefined ? {} : { commandClient })}
        {...(authClient === undefined ? {} : { authClient })}
        {...(session === undefined ? {} : { session })}
        {...(photoPort === undefined ? {} : { photoPort })}
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
    </main>
  );
}
