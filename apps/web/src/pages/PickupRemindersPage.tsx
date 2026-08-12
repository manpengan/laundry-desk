import { DEFAULT_PICKUP_REMINDER_TEMPLATE, isPickupReminderTemplate } from "@laundry/domain";
import { Button, MoneyText, useToast } from "@laundry/ui";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { unwrapQueryResult } from "./customer-model.js";
import { ManualNotificationConfirmDialog } from "./ManualNotificationConfirmDialog.js";
import { NotificationDeliveryPanel } from "./NotificationDeliveryPanel.js";
import {
  copyManualListPhones,
  downloadManualList,
  verifyManualListDigest,
} from "./pickup-reminder-export.js";
import {
  parseManualListResult,
  parsePickupReminderList,
  previewPickupReminderMessages,
  type PickupReminderFilterState,
  type PickupReminderStatus,
  type PickupReminderView,
} from "./pickup-reminder-model.js";

type ManualBody = Readonly<{
  order_ids: readonly string[];
  group_by: "order" | "customer";
  message_template: string;
  format: "csv";
  min_age_days: 30 | 90 | 180;
  unpaid_only: boolean;
  garment_statuses: readonly PickupReminderStatus[];
}>;

type Pending = Readonly<{
  confirmRef: string;
  orderCount: number;
  messages: readonly string[];
}>;

export type PickupRemindersPageProps = Readonly<{
  commandClient: CommandPort;
  queryClient: QueryPort;
  session?: SessionView;
  authClient?: AuthClient;
}>;

const INITIAL_FILTERS: PickupReminderFilterState = Object.freeze({
  minAgeDays: 90,
  unpaidOnly: false,
  statuses: Object.freeze(["ready", "racked"] as const),
});

function statusLabel(status: PickupReminderStatus): string {
  return status === "ready" ? "已洗好" : "已上架";
}

function contactTime(value: string | null): string {
  return value === null ? "从未生成" : value.replace("T", " ").slice(0, 16);
}

export function resumeManualNotification(commandClient: CommandPort, confirmRef: string) {
  return commandClient.execute("notification.manual_list.create", {}, { confirmRef });
}

export function PickupRemindersPage({
  commandClient,
  queryClient,
  session,
  authClient,
}: PickupRemindersPageProps) {
  const toast = useToast();
  const [filters, setFilters] = useState<PickupReminderFilterState>(INITIAL_FILTERS);
  const [rows, setRows] = useState<readonly PickupReminderView[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [groupBy, setGroupBy] = useState<"order" | "customer">("order");
  const [template, setTemplate] = useState(DEFAULT_PICKUP_REMINDER_TEMPLATE);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const result = await queryClient.execute<unknown>("notification.pickup_reminders.list", {
        min_age_days: filters.minAgeDays,
        unpaid_only: filters.unpaidOnly,
        garment_statuses: filters.statuses,
        limit: 200,
      });
      if (!result.ok) {
        toast.push(result.error.message ?? result.error.code, "error");
        return;
      }
      const parsed = parsePickupReminderList(unwrapQueryResult(result.data));
      if (parsed === null) {
        toast.push("催取名单无法解析", "error");
        return;
      }
      setRows(parsed.candidates);
      setSelected(
        (current) =>
          new Set(
            [...current].filter((id) => parsed.candidates.some((row) => row.order_id === id)),
          ),
      );
    } finally {
      setBusy(false);
    }
  }, [filters, queryClient, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const preview = useMemo(() => {
    if (!isPickupReminderTemplate(template)) return [];
    return previewPickupReminderMessages(rows, selected, groupBy, template);
  }, [groupBy, rows, selected, template]);

  const toggleStatus = (status: PickupReminderStatus): void => {
    setFilters((current) => {
      const has = current.statuses.includes(status);
      if (has && current.statuses.length === 1) return current;
      return Object.freeze({
        ...current,
        statuses: has
          ? current.statuses.filter((item) => item !== status)
          : Object.freeze([...current.statuses, status]),
      });
    });
  };

  const toggleOrder = (orderId: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(orderId)) next.delete(orderId);
      else if (next.size < 50) next.add(orderId);
      else toast.push("单次最多选择 50 单", "error");
      return next;
    });
  };

  const finish = useCallback(
    async (data: unknown) => {
      const exported = parseManualListResult(unwrapQueryResult(data));
      if (exported === null || !(await verifyManualListDigest(exported))) {
        toast.push("名单摘要校验失败，未下载", "error");
        return;
      }
      const downloaded = downloadManualList(exported);
      const copied = await copyManualListPhones(exported);
      if (!downloaded) toast.push("浏览器无法下载名单", "error");
      toast.push(
        copied ? "名单已生成，号码已复制" : "名单已生成；请从 CSV 手动复制号码",
        "success",
      );
      setSelected(new Set());
      await load();
    },
    [load, toast],
  );

  const create = useCallback(async () => {
    if (selected.size === 0 || !isPickupReminderTemplate(template)) {
      toast.push(selected.size === 0 ? "请先选择订单" : "模板含不支持的占位符", "error");
      return;
    }
    const body: ManualBody = Object.freeze({
      order_ids: Object.freeze([...selected]),
      group_by: groupBy,
      message_template: template.trim(),
      format: "csv",
      min_age_days: filters.minAgeDays,
      unpaid_only: filters.unpaidOnly,
      garment_statuses: filters.statuses,
    });
    setBusy(true);
    try {
      const result = await commandClient.execute("notification.manual_list.create", body);
      if (result.ok) {
        await finish(result.data);
        return;
      }
      if (isStepUpRequired(result) && result.error.code === "POLICY_CONFIRMATION_REQUIRED") {
        setPending(
          Object.freeze({
            confirmRef: result.error.detail.confirm_ref,
            orderCount: body.order_ids.length,
            messages: Object.freeze(preview.map((row) => row.message)),
          }),
        );
        return;
      }
      toast.push(result.error.message ?? result.error.code, "error");
    } finally {
      setBusy(false);
    }
  }, [commandClient, filters, finish, groupBy, preview, selected, template, toast]);

  const confirm = useCallback(async () => {
    if (pending === null) return;
    setBusy(true);
    try {
      const result = await resumeManualNotification(commandClient, pending.confirmRef);
      if (!result.ok) {
        toast.push(result.error.message ?? result.error.code, "error");
        return;
      }
      setPending(null);
      await finish(result.data);
    } finally {
      setBusy(false);
    }
  }, [commandClient, finish, pending, toast]);

  const selectedOrderIds = useMemo(() => Object.freeze([...selected]), [selected]);
  const restoreManualFallback = useCallback(
    (orderIds: readonly string[]) => {
      const visible = orderIds.filter((id) => rows.some((row) => row.order_id === id));
      setSelected(new Set(visible));
      if (visible.length === 0) {
        toast.push("这些订单不在当前筛选中；请调整超期、欠款或衣物状态后重试", "error");
        return;
      }
      toast.push(
        visible.length === orderIds.length
          ? `已将 ${visible.length} 单带回人工名单`
          : `已带回 ${visible.length} 单；其余订单不在当前筛选中`,
        "success",
      );
    },
    [rows, toast],
  );

  return (
    <main className="ld-shell-main lg-card ld-reminders" id="main-content" tabIndex={-1}>
      <header className="ld-reminders__header">
        <div>
          <h1 className="ld-shell-main__title">催取工作台</h1>
          <p className="ld-shell-main__hint">人工名单只生成联系材料，不会自行发送短信或微信。</p>
        </div>
        <Button type="button" onClick={() => void load()} disabled={busy}>
          刷新候选
        </Button>
      </header>

      <section className="ld-reminders__filters" aria-label="催取筛选">
        <label>
          超期
          <select
            value={filters.minAgeDays}
            onChange={(event) =>
              setFilters((current) =>
                Object.freeze({
                  ...current,
                  minAgeDays: Number(event.target.value) as 30 | 90 | 180,
                }),
              )
            }
          >
            <option value={30}>30 天</option>
            <option value={90}>90 天</option>
            <option value={180}>180 天</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={filters.unpaidOnly}
            onChange={(event) =>
              setFilters((current) =>
                Object.freeze({ ...current, unpaidOnly: event.target.checked }),
              )
            }
          />
          仅欠款
        </label>
        {(["ready", "racked"] as const).map((status) => (
          <label key={status}>
            <input
              type="checkbox"
              checked={filters.statuses.includes(status)}
              onChange={() => toggleStatus(status)}
            />
            {statusLabel(status)}
          </label>
        ))}
      </section>

      <div className="ld-reminders__table-wrap">
        <table className="ld-reminders__table" aria-busy={busy}>
          <thead>
            <tr>
              <th>选择</th>
              <th>顾客 / 电话</th>
              <th>订单</th>
              <th>超期</th>
              <th>衣物</th>
              <th>欠款</th>
              <th>最近生成</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7}>当前筛选下没有催取候选</td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.order_id} data-testid="pickup-reminder-row">
                  <td>
                    <input
                      aria-label={`选择订单 ${row.ticket_no}`}
                      type="checkbox"
                      checked={selected.has(row.order_id)}
                      onChange={() => toggleOrder(row.order_id)}
                    />
                  </td>
                  <td>
                    <strong>{row.customer_name ?? "未留姓名"}</strong>
                    <br />
                    <span>{row.customer_phone}</span>
                  </td>
                  <td>{row.ticket_no}</td>
                  <td>{row.overdue_days} 天</td>
                  <td>
                    {row.garment_count} 件 · {row.garment_statuses.map(statusLabel).join("/")}
                  </td>
                  <td>
                    <MoneyText fen={row.balance_cents} size="sm" />
                  </td>
                  <td>{contactTime(row.last_contact_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {session === undefined ? null : (
        <NotificationDeliveryPanel
          commandClient={commandClient}
          queryClient={queryClient}
          session={session}
          {...(authClient === undefined ? {} : { authClient })}
          filters={filters}
          selectedOrderIds={selectedOrderIds}
          onManualFallback={restoreManualFallback}
        />
      )}

      <section className="ld-reminders__composer" aria-label="人工名单设置">
        <label>
          分组方式
          <select
            value={groupBy}
            onChange={(event) => setGroupBy(event.target.value as "order" | "customer")}
          >
            <option value="order">每单一行</option>
            <option value="customer">同顾客合并</option>
          </select>
        </label>
        <label className="ld-reminders__template">
          联系话术
          <textarea
            value={template}
            maxLength={256}
            onChange={(event) => setTemplate(event.target.value)}
          />
        </label>
        <p>
          支持：<code>{"{{tickets}}"}</code>、<code>{"{{garment_count}}"}</code>、
          <code>{"{{balance_cents}}"}</code>
        </p>
        <Button
          variant="primary"
          type="button"
          onClick={() => void create()}
          disabled={busy || selected.size === 0}
        >
          生成名单并复制号码（{selected.size}/50）
        </Button>
      </section>

      <ManualNotificationConfirmDialog
        confirmation={
          pending === null
            ? null
            : Object.freeze({ orderCount: pending.orderCount, messages: pending.messages })
        }
        busy={busy}
        onClose={() => setPending(null)}
        onConfirm={() => void confirm()}
      />
    </main>
  );
}
