import type { FulfillmentOperationConfirmationSummary } from "@laundry/contracts";
import { Button, Input, useToast } from "@laundry/ui";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import { DangerConfirmDialog } from "./DangerConfirmDialog.js";
import { FulfillmentRackPanel } from "./FulfillmentRackPanel.js";
import {
  FulfillmentOperationConfirmation,
  readFulfillmentOperationSummary,
} from "./FulfillmentOperationConfirmation.js";
import { FulfillmentWorkbenchRow } from "./FulfillmentWorkbenchRow.js";
import {
  FULFILLMENT_STATUS_LABELS,
  parseFulfillmentRows,
  transitionCommandForCount,
  unwrapFulfillmentResult,
  type FulfillmentRowView,
  type FulfillmentStatus,
} from "./fulfillment-model.js";

export type FulfillmentPageProps = Readonly<{
  queryClient: QueryPort;
  commandClient: CommandPort;
  authClient: AuthClient;
  session: SessionView;
}>;

type PendingAction = Readonly<{
  confirmRef: string;
  command: string;
  label: string;
  kind: "confirm" | "step_up";
  summary: FulfillmentOperationConfirmationSummary;
}>;

const ACTIVE_STATUSES: readonly FulfillmentStatus[] = Object.freeze([
  "received",
  "washing",
  "ready",
  "racked",
  "reworked",
]);

const integerCents = (value: string): number | null => {
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

export function FulfillmentPage({
  queryClient,
  commandClient,
  authClient,
  session,
}: FulfillmentPageProps) {
  const toast = useToast();
  const [rows, setRows] = useState<readonly FulfillmentRowView[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<FulfillmentStatus | "active" | "all">("active");
  const [note, setNote] = useState("");
  const [compensationCents, setCompensationCents] = useState("0");
  const [incidentKind, setIncidentKind] = useState<"damage" | "other">("damage");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const statuses =
        status === "active" ? ACTIVE_STATUSES : status === "all" ? undefined : [status];
      const result = await queryClient.execute<unknown>("fulfillment.workbench", {
        ...(statuses === undefined ? {} : { statuses }),
        ...(key.trim().length === 0 ? {} : { key: key.trim() }),
        limit: 100,
      });
      if (!result.ok) {
        toast.push(result.error.message ?? result.error.code, "error");
        return;
      }
      const parsed = parseFulfillmentRows(unwrapFulfillmentResult(result.data));
      if (parsed === null) {
        toast.push("生产工作台响应格式错误", "error");
        return;
      }
      setRows(parsed);
      setSelected((current) => {
        const visibleIds = new Set(parsed.map((row) => row.garment_id));
        return new Set([...current].filter((id) => visibleIds.has(id)));
      });
    } finally {
      setBusy(false);
    }
  }, [key, queryClient, status, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedRows = useMemo(
    () => rows.filter((row) => selected.has(row.garment_id)),
    [rows, selected],
  );
  const ids = useMemo(() => selectedRows.map((row) => row.garment_id), [selectedRows]);

  const finish = useCallback(async () => {
    setSelected(new Set());
    setNote("");
    setCompensationCents("0");
    await load();
  }, [load]);

  const executeAction = useCallback(
    async (command: string, body: unknown, label: string) => {
      setBusy(true);
      try {
        const result = await commandClient.execute<unknown>(command, body);
        if (result.ok) {
          toast.push(`${label}完成`, "success");
          await finish();
          return;
        }
        if (isStepUpRequired(result)) {
          const summary = readFulfillmentOperationSummary(result.error.detail.summary);
          if (summary === null) {
            toast.push("服务端未返回可核对的生产操作摘要", "error");
            return;
          }
          setPending(
            Object.freeze({
              confirmRef: result.error.detail.confirm_ref,
              command,
              label,
              kind: result.error.code === "POLICY_STEP_UP_REQUIRED" ? "step_up" : "confirm",
              summary,
            }),
          );
          return;
        }
        toast.push(result.error.message ?? result.error.code, "error");
      } finally {
        setBusy(false);
      }
    },
    [commandClient, finish, toast],
  );

  const resumePending = useCallback(async () => {
    if (pending === null) return;
    setBusy(true);
    try {
      const result = await commandClient.execute<unknown>(
        pending.command,
        {},
        { confirmRef: pending.confirmRef },
      );
      if (!result.ok) {
        toast.push(result.error.message ?? result.error.code, "error");
        return;
      }
      toast.push(`${pending.label}完成`, "success");
      setPending(null);
      await finish();
    } finally {
      setBusy(false);
    }
  }, [commandClient, finish, pending, toast]);

  const transition = useCallback(
    (target: "washing" | "ready") => {
      if (ids.length === 0) return;
      const command = transitionCommandForCount(ids.length);
      const body =
        command === "garment.transition"
          ? {
              garment_id: ids[0],
              target_status: target,
              ...(note.trim() ? { note: note.trim() } : {}),
            }
          : {
              garment_ids: ids,
              target_status: target,
              ...(note.trim() ? { note: note.trim() } : {}),
            };
      void executeAction(command, body, FULFILLMENT_STATUS_LABELS[target]);
    },
    [executeAction, ids, note],
  );

  const requireReason = useCallback((): string | null => {
    const value = note.trim();
    if (value.length === 0) {
      toast.push("请填写异常、返工或丢损原因", "error");
      return null;
    }
    return value;
  }, [note, toast]);

  const recordIncident = useCallback(() => {
    if (ids.length !== 1) return;
    const reason = requireReason();
    const compensation = integerCents(compensationCents);
    if (reason === null || compensation === null) {
      if (compensation === null) toast.push("赔付金额必须是非负整数分", "error");
      return;
    }
    void executeAction(
      "garment.incident.record",
      {
        garment_id: ids[0],
        kind: incidentKind,
        note: reason,
        compensation_cents: compensation,
      },
      "异常登记",
    );
  }, [compensationCents, executeAction, ids, incidentKind, requireReason, toast]);

  const markLost = useCallback(() => {
    if (ids.length !== 1) return;
    const reason = requireReason();
    const compensation = integerCents(compensationCents);
    if (reason === null || compensation === null) {
      if (compensation === null) toast.push("赔付金额必须是非负整数分", "error");
      return;
    }
    void executeAction(
      "garment.mark_lost",
      { garment_id: ids[0], reason, compensation_cents: compensation },
      "标记丢损",
    );
  }, [compensationCents, executeAction, ids, requireReason, toast]);

  return (
    <main className="ld-shell-main lg-card ld-fulfillment" id="main-content" tabIndex={-1}>
      <header className="ld-fulfillment__header">
        <div>
          <h1 className="ld-shell-main__title">生产工作台</h1>
          <p>按件流转加工、完成、待取；批量、返工和异常全程留痕。</p>
        </div>
        <Button variant="secondary" type="button" onClick={() => void load()} disabled={busy}>
          刷新
        </Button>
      </header>

      <section className="ld-fulfillment__filters" aria-label="生产筛选">
        <Input
          name="fulfillment-key"
          label="票号 / 条码 / 客户"
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <label>
          <span>状态</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as typeof status)}
          >
            <option value="active">活动件</option>
            <option value="all">全部</option>
            {Object.entries(FULFILLMENT_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </section>

      <FulfillmentRackPanel commandClient={commandClient} onAssigned={finish} />

      <section className="ld-fulfillment__actions" aria-label="批量操作">
        <strong>已选 {ids.length} 件</strong>
        <Button
          type="button"
          onClick={() => transition("washing")}
          disabled={busy || ids.length === 0}
        >
          进入加工
        </Button>
        <Button
          type="button"
          onClick={() => transition("ready")}
          disabled={busy || ids.length === 0}
        >
          标记完成
        </Button>
        <Button
          variant="secondary"
          type="button"
          onClick={() => {
            const reason = requireReason();
            if (reason !== null && ids.length > 0) {
              void executeAction("garment.rework", { garment_ids: ids, reason }, "返工登记");
            }
          }}
          disabled={busy || ids.length === 0}
        >
          返工
        </Button>
      </section>

      <section className="ld-fulfillment__incident" aria-label="异常和丢损">
        <Input
          name="fulfillment-note"
          label="原因 / 备注"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <Input
          name="fulfillment-compensation"
          label="赔付（分）"
          inputMode="numeric"
          value={compensationCents}
          onChange={(event) => setCompensationCents(event.target.value)}
        />
        <select
          value={incidentKind}
          onChange={(event) => setIncidentKind(event.target.value as typeof incidentKind)}
        >
          <option value="damage">损坏</option>
          <option value="other">其他</option>
        </select>
        <Button
          variant="secondary"
          type="button"
          onClick={recordIncident}
          disabled={busy || ids.length !== 1}
        >
          登记异常
        </Button>
        <Button
          variant="danger"
          type="button"
          onClick={markLost}
          disabled={busy || ids.length !== 1}
        >
          标记丢损
        </Button>
      </section>

      <div className="ld-fulfillment__table" role="table" aria-busy={busy}>
        {rows.map((row) => (
          <FulfillmentWorkbenchRow
            key={row.garment_id}
            row={row}
            checked={selected.has(row.garment_id)}
            onToggle={(checked) =>
              setSelected((current) => {
                const next = new Set(current);
                if (checked) next.add(row.garment_id);
                else next.delete(row.garment_id);
                return next;
              })
            }
          />
        ))}
        {!busy && rows.length === 0 ? (
          <p className="ld-fulfillment__empty">当前筛选没有衣物。</p>
        ) : null}
      </div>

      <DangerConfirmDialog
        open={pending?.kind === "confirm"}
        title="确认批量生产操作"
        description={pending === null ? "" : `服务端已冻结「${pending.label}」的件清单。`}
        summary={
          pending === null ? undefined : (
            <FulfillmentOperationConfirmation summary={pending.summary} />
          )
        }
        confirmLabel="确认执行"
        serverConfirmation
        busy={busy}
        onClose={() => setPending(null)}
        onConfirm={() => void resumePending()}
      />
      {pending?.kind === "step_up" ? (
        <StepUpConfirmDialog
          open
          onClose={() => setPending(null)}
          authClient={authClient}
          confirmRef={pending.confirmRef}
          currentStaffId={session.session.staff_id}
          commandLabel={pending.label}
          summary={<FulfillmentOperationConfirmation summary={pending.summary} />}
          onApproved={() => void resumePending()}
        />
      ) : null}
    </main>
  );
}
