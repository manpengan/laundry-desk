/** 工作队列 (ADR-100): the orders the counter acts on, one tab per kind of follow-up. */

import { EmptyState, Icon, Kbd, MoneyText, Skeleton, Tabs, maskPhone } from "@laundry/ui";
import type { KeyboardEvent } from "react";

import type { NavItemId } from "../../nav.js";
import type { OrderListRowView } from "../OrdersList.js";
import type { OrderRows } from "./workbench-loaders.js";
import type { QueueTabId, WorkbenchData } from "./use-workbench-data.js";
import {
  receivedLabel,
  toMillis,
  waitView,
  type GarmentGroup,
  type GarmentStage,
} from "./workbench-model.js";

type TabSpec = Readonly<{
  id: QueueTabId;
  label: string;
  tone: "accent" | "late" | "warn" | "plain";
  empty: string;
  more: NavItemId;
}>;

const TABS: readonly TabSpec[] = Object.freeze([
  { id: "open", label: "未取件", tone: "accent", empty: "暂无未取件订单", more: "orders" },
  { id: "ready", label: "已上架", tone: "plain", empty: "暂无已上架待取的订单", more: "orders" },
  {
    id: "overdue",
    label: "超 30 天",
    tone: "late",
    empty: "没有超过 30 天未取的订单",
    more: "reminders",
  },
  { id: "debt", label: "欠款", tone: "warn", empty: "没有欠款订单", more: "orders" },
  { id: "drafts", label: "挂单", tone: "plain", empty: "没有挂单", more: "receive" },
]);

export type WorkbenchQueueProps = Readonly<{
  data: WorkbenchData;
  fulfillment: boolean;
  tab: QueueTabId;
  onTab: (tab: QueueTabId) => void;
  onOpenPickup: (orderId: string) => void;
  onNavigate: (id: NavItemId) => void;
}>;

function visibleTabs(fulfillment: boolean): readonly TabSpec[] {
  return TABS.filter((spec) => spec.id !== "ready" || fulfillment);
}

/** Debts read oldest first; every other tab keeps its loader's order. */
function shownRows(tab: QueueTabId, rows: OrderRows): readonly OrderListRowView[] {
  const list =
    tab === "debt"
      ? [...rows.orders].sort((a, b) => toMillis(a.created_at) - toMillis(b.created_at))
      : rows.orders;
  return list.slice(0, 20);
}

function moveFocus(event: KeyboardEvent<HTMLUListElement>): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>(".ld-wb-row__main"),
  );
  const index = rows.findIndex((row) => row === document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  rows[
    Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))
  ]?.focus();
}

const STAGE_LABELS: Readonly<Record<Exclude<GarmentStage, "racked">, string>> = Object.freeze({
  ready: "待上架",
  washing: "洗涤中",
  received: "已收件",
});

/** Rack slots once racked; otherwise how far the order's garments have got. */
function rackCell(order: OrderListRowView, group: GarmentGroup | undefined) {
  if (order.status === "closed") return { stage: "gone", label: "已取走" };
  if (group === undefined) return { stage: "none", label: "未上架" };
  if (group.stage !== "racked") return { stage: group.stage, label: STAGE_LABELS[group.stage] };
  return { stage: "racked", label: group.racks.length === 0 ? "已上架" : group.racks.join(" ") };
}

/** Drafts continue on 开单; picked-up orders still owing settle in 订单与欠款. */
function rowAction(order: OrderListRowView): Readonly<{ label: string; page: NavItemId | null }> {
  if (order.status === "draft") return { label: "继续开单", page: "receive" };
  if (order.status === "closed") return { label: "收欠款", page: "orders" };
  return { label: "取衣", page: null };
}

function QueueRow({
  order,
  group,
  now,
  racks,
  onOpen,
  onRemind,
}: Readonly<{
  order: OrderListRowView;
  group: GarmentGroup | undefined;
  now: number;
  racks: boolean;
  onOpen: () => void;
  onRemind?: (() => void) | undefined;
}>) {
  const wait = waitView(order.created_at, now);
  const pieces = order.garment_count === undefined ? "" : `${order.garment_count} 件`;
  const rack = rackCell(order, group);
  return (
    <li className="ld-wb-row">
      <button type="button" className="ld-wb-row__main" onClick={onOpen}>
        <span className="ld-wb-row__ticket">
          <strong className="ld-wb-mono">{order.ticket_no ?? "挂单"}</strong>
          <small>{receivedLabel(order.created_at, now)}</small>
        </span>
        <span className="ld-wb-row__who">
          <strong>{order.customer_name ?? "散客"}</strong>
          <small className="ld-wb-mono">
            {order.customer_phone === null ? "未留手机号" : maskPhone(order.customer_phone)}
          </small>
        </span>
        <span className="ld-wb-row__items">
          <span>{group?.items ?? (pieces || "衣物明细见订单")}</span>
          {group === undefined || pieces === "" ? null : <small>{pieces}</small>}
        </span>
        {racks ? (
          <span className="ld-wb-row__rack ld-wb-mono" data-stage={rack.stage}>
            {rack.label}
          </span>
        ) : null}
        <span className="ld-wb-chip" data-tone={wait.tone}>
          {wait.label}
        </span>
        <span className="ld-wb-row__due">
          {order.balance_cents > 0 ? <MoneyText fen={order.balance_cents} /> : "已付清"}
        </span>
        <span className="ld-wb-row__go" aria-hidden="true">
          {rowAction(order).label}
          <Icon name="chevronRight" size={14} />
        </span>
      </button>
      {onRemind === undefined ? null : (
        <button
          type="button"
          className="ld-wb-row__remind"
          aria-label={`催取 ${order.ticket_no ?? ""}`}
          onClick={onRemind}
        >
          <Icon name="reminders" size={16} />
        </button>
      )}
    </li>
  );
}

function QueueBody({
  spec,
  rows,
  data,
  fulfillment,
  onOpenPickup,
  onNavigate,
}: Readonly<{ spec: TabSpec; rows: OrderRows | null | undefined }> &
  Omit<WorkbenchQueueProps, "tab" | "onTab">) {
  if (rows === undefined) {
    return <Skeleton lines={5} className="ld-wb-queue__loading" />;
  }
  if (rows === null) {
    return <p className="ld-wb-queue__notice">这类订单暂时读不到，稍后会自动重试。</p>;
  }
  if (rows.orders.length === 0) {
    return (
      <EmptyState
        icon={<Icon name="check" size={24} />}
        title={spec.empty}
        {...(spec.id === "open"
          ? {
              description: "开单后，未取件的订单会出现在这里。",
              actionLabel: "去开单",
              onAction: () => onNavigate("receive"),
            }
          : {})}
      />
    );
  }
  const now = Date.now();
  return (
    <>
      <div className="ld-wb-queue__cols" aria-hidden="true">
        <span>票号</span>
        <span>顾客</span>
        <span className="ld-wb-row__items">衣物</span>
        {fulfillment ? <span>货架</span> : null}
        <span>等待</span>
        <span>待收</span>
        <span>操作</span>
      </div>
      <ul className="ld-wb-queue__list" onKeyDown={moveFocus}>
        {shownRows(spec.id, rows).map((order) => {
          const { page } = rowAction(order);
          return (
            <QueueRow
              key={order.order_id}
              order={order}
              group={data.groups.get(order.order_id)}
              now={now}
              racks={fulfillment}
              onOpen={() => (page === null ? onOpenPickup(order.order_id) : onNavigate(page))}
              onRemind={spec.id === "overdue" ? () => onNavigate("reminders") : undefined}
            />
          );
        })}
      </ul>
    </>
  );
}

export function WorkbenchQueue(props: WorkbenchQueueProps) {
  const { data, fulfillment, tab, onTab, onNavigate } = props;
  const tabs = visibleTabs(fulfillment);
  const spec = tabs.find((candidate) => candidate.id === tab) ?? tabs[0]!;
  const rows = data.queues[spec.id];
  return (
    <section className="ld-wb-card ld-wb-queue" aria-label="工作队列">
      <header className="ld-wb-queue__head">
        <h2 className="ld-wb-card__title">
          <Icon name="orders" size={18} />
          工作队列
        </h2>
        <Tabs<QueueTabId>
          label="队列筛选"
          className="ld-wb-queue__tabs"
          value={spec.id}
          onChange={onTab}
          items={tabs.map((candidate) => {
            const total = data.queues[candidate.id]?.total;
            return {
              id: candidate.id,
              label: (
                <>
                  {candidate.label}
                  <span className="ld-wb-count" data-tone={candidate.tone}>
                    {total === undefined ? "…" : total}
                  </span>
                </>
              ),
            };
          })}
        />
        <button type="button" className="ld-wb-link" onClick={() => onNavigate(spec.more)}>
          {spec.more === "reminders" ? "去催取" : spec.more === "receive" ? "去开单" : "全部订单"}
          <Icon name="arrowRight" size={14} />
        </button>
      </header>
      <div
        className="ld-wb-queue__body"
        data-testid="counter-workbench-orders"
        data-racks={fulfillment ? "on" : "off"}
        data-remind={spec.id === "overdue" ? "on" : undefined}
      >
        <QueueBody spec={spec} rows={rows} {...props} />
      </div>
      <footer className="ld-wb-queue__foot">
        <span>
          {rows === undefined || rows === null
            ? "按需要处理的先后排列"
            : `共 ${rows.total} 单${rows.total > 20 ? " · 显示前 20 单" : ""}`}
        </span>
        <span className="ld-wb-queue__keys" aria-hidden="true">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> 选择 <Kbd>Enter</Kbd> 打开
        </span>
      </footer>
    </section>
  );
}
