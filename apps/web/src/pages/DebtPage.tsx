/**
 * 统一订单中心：全部、欠款和待取视图，服务端分页。
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
import type { OrderListRowView } from "./OrdersList.js";
import { OrderDetailDrawer } from "./OrderDetailDrawer.js";
import { ListLoadNotice } from "./ListLoadNotice.js";
import { useOrderPage } from "./use-order-page.js";
import { OrderPagination } from "./OrderPagination.js";
import { INITIAL_ORDER_FILTER, OrderCenterFilters, orderViewLabel } from "./OrderCenterFilters.js";

const DEBT_LIST_LIMIT = 50;

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
  const list = useOrderPage(queryClient);
  const { page, busy, error } = list;
  const rows = page?.orders ?? [];
  const loaded = page !== null;
  const viewLabel = orderViewLabel(list.applied);
  const [detailOrderId, setDetailOrderId] = useState<string | null>(null);
  const load = list.retry;
  useEffect(() => {
    void list.load({ ...INITIAL_ORDER_FILTER, offset: 0, limit: DEBT_LIST_LIMIT });
  }, [list.load]);

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
        按票号、客户、营业日和状态查询完整历史。待取视图仅包含有衣物已上架的订单。
      </p>
      <OrderCenterFilters
        busy={busy}
        onSearch={(body) => void list.load({ ...body, offset: 0, limit: DEBT_LIST_LIMIT })}
      />
      <section className="ld-section ld-debt" data-testid="debt-section" aria-label="订单结果">
        <div className="ld-section__head">
          <h2 className="ld-section__title">
            {viewLabel}
            {page ? <span className="ld-section__count">{page.total}</span> : null}
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
            {busy ? "加载中…" : "刷新订单"}
          </Button>
        </div>
        <ListLoadNotice
          error={error}
          loaded={loaded}
          busy={busy}
          onRetry={() => void load()}
          testId="debt-load-error"
        />

        {busy && loaded ? <p role="status">正在更新；下方暂时保留上次查询结果。</p> : null}
        {page === null ? null : (
          <OrderPagination
            {...page}
            busy={busy}
            onPage={(offset) => void list.load({ ...list.applied, offset })}
          />
        )}
        <ul className="ld-orders-list" data-testid="debt-list">
          {rows.length === 0 && error !== null ? (
            <li className="ld-orders-list__empty">订单信息未能更新</li>
          ) : !loaded && busy ? (
            <li className="ld-orders-list__empty">正在加载订单…</li>
          ) : !loaded ? (
            <li className="ld-orders-list__empty">正在准备订单列表</li>
          ) : rows.length === 0 ? (
            <li className="ld-orders-list__empty">
              {(page?.total ?? 0) > 0 ? "当前页已无订单，请返回上一页。" : "暂无符合条件的订单"}
            </li>
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
                    {onOpenPickup !== undefined && row.status === "open" ? (
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
                    {row.balance_cents > 0 ? (
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
                    ) : null}
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
