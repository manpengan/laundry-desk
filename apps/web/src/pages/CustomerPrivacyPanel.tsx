import { Button, Input, useToast } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import {
  downloadCustomerPrivacyExport,
  parseCustomerPrivacyEvents,
  parseCustomerPrivacyExport,
  parseCustomerPrivacyStatus,
  type CustomerPrivacyEventView,
  type CustomerPrivacyStatusView,
} from "./customer-privacy.js";
import type { CustomerRowView } from "./customer-model.js";

type PrivacyCommand = "customer.privacy.export" | "customer.anonymize";

type PendingAction = Readonly<{
  command: PrivacyCommand;
  confirmRef: string;
  label: string;
}>;

export type CustomerPrivacyPanelProps = Readonly<{
  customer: CustomerRowView;
  queryClient: QueryPort;
  commandClient: CommandPort;
  authClient?: AuthClient;
  session?: SessionView;
  onAnonymized: () => void;
}>;

export function CustomerPrivacyPanel({
  customer,
  queryClient,
  commandClient,
  authClient,
  session,
  onAnonymized,
}: CustomerPrivacyPanelProps) {
  const toast = useToast();
  const [status, setStatus] = useState<CustomerPrivacyStatusView | null>(null);
  const [events, setEvents] = useState<readonly CustomerPrivacyEventView[]>([]);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const loadGenerationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    const [statusResult, eventsResult] = await Promise.all([
      queryClient.execute<unknown>("customer.privacy.status", {
        customer_id: customer.customer_id,
      }),
      queryClient.execute<unknown>("customer.privacy.events", {
        customer_id: customer.customer_id,
        limit: 20,
      }),
    ]);
    if (generation !== loadGenerationRef.current) return;
    if (!statusResult.ok || !eventsResult.ok) {
      toast.push("客户隐私状态暂时无法加载", "error");
      return;
    }
    const nextStatus = parseCustomerPrivacyStatus(statusResult.data);
    const nextEvents = parseCustomerPrivacyEvents(eventsResult.data);
    if (generation !== loadGenerationRef.current) return;
    if (nextStatus === null || nextEvents === null) {
      toast.push("客户隐私状态无法解析", "error");
      return;
    }
    setStatus(nextStatus);
    setEvents(nextEvents);
  }, [customer.customer_id, queryClient, toast]);

  useEffect(() => {
    loadGenerationRef.current += 1;
    setStatus(null);
    setEvents([]);
    setReason("");
    setConfirmation("");
    setPending(null);
    void load();
    return () => {
      loadGenerationRef.current += 1;
    };
  }, [load]);

  const finish = useCallback(
    async (command: PrivacyCommand, data: unknown) => {
      if (command === "customer.privacy.export") {
        const exported = parseCustomerPrivacyExport(data);
        if (exported === null) {
          toast.push("客户导出文件无法解析", "error");
          return;
        }
        downloadCustomerPrivacyExport(exported);
        toast.push("客户数据已导出并记录审计", "success");
        await load();
        return;
      }
      toast.push("客户直接身份信息已不可逆匿名化", "success");
      onAnonymized();
    },
    [load, onAnonymized, toast],
  );

  const execute = useCallback(
    async (command: PrivacyCommand, body: Readonly<Record<string, unknown>>, label: string) => {
      setBusy(true);
      try {
        const result = await commandClient.execute<unknown>(command, body);
        if (result.ok) {
          await finish(command, result.data);
          return;
        }
        if (isStepUpRequired(result)) {
          if (authClient === undefined || session === undefined) {
            toast.push("当前客户端无法完成现场复核", "error");
            return;
          }
          setPending(
            Object.freeze({
              command,
              confirmRef: result.error.detail.confirm_ref,
              label,
            }),
          );
          return;
        }
        toast.push(result.error.message ?? result.error.code, "error");
      } finally {
        setBusy(false);
      }
    },
    [authClient, commandClient, finish, session, toast],
  );

  const resume = useCallback(async () => {
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
      const command = pending.command;
      setPending(null);
      await finish(command, result.data);
    } finally {
      setBusy(false);
    }
  }, [commandClient, finish, pending, toast]);

  const exportData = useCallback(() => {
    const trimmedReason = reason.trim();
    if (trimmedReason.length === 0) {
      toast.push("请填写隐私操作原因", "error");
      return;
    }
    void execute(
      "customer.privacy.export",
      { customer_id: customer.customer_id, reason: trimmedReason },
      "导出客户数据",
    );
  }, [customer.customer_id, execute, reason, toast]);

  const anonymize = useCallback(() => {
    const trimmedReason = reason.trim();
    if (trimmedReason.length === 0 || confirmation !== "ANONYMIZE") {
      toast.push("请填写原因并准确输入 ANONYMIZE", "error");
      return;
    }
    void execute(
      "customer.anonymize",
      {
        customer_id: customer.customer_id,
        reason: trimmedReason,
        confirmation,
      },
      "不可逆匿名化",
    );
  }, [confirmation, customer.customer_id, execute, reason, toast]);

  return (
    <section className="ld-customer-privacy" aria-label="客户隐私与留存">
      <div className="ld-customer-privacy__head">
        <div>
          <h3>隐私与留存</h3>
          <p>导出与匿名化均需另一位店长复核，并写入不可变审计记录。</p>
        </div>
        <span data-testid="customer-privacy-status">
          {status === null
            ? "正在读取…"
            : `活动订单 ${status.active_order_count} · 留存订单 ${status.retained_order_count} · 照片 ${status.photo_count}`}
        </span>
      </div>

      {status !== null && !status.anonymization_eligible ? (
        <p className="ld-customer-privacy__blocked" role="alert">
          尚有活动订单，必须完成或取消后才能匿名化。
        </p>
      ) : null}

      <div className="ld-customer-privacy__fields">
        <Input
          name="customer-privacy-reason"
          label="操作原因"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={busy}
          data-testid="customer-privacy-reason"
        />
        <Input
          name="customer-privacy-confirmation"
          label="匿名化确认短语"
          placeholder="ANONYMIZE"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          disabled={busy}
          data-testid="customer-privacy-confirmation"
        />
      </div>
      <div className="ld-customer-privacy__actions">
        <Button
          variant="secondary"
          type="button"
          onClick={exportData}
          disabled={busy}
          data-testid="customer-privacy-export"
        >
          导出客户数据
        </Button>
        <Button
          variant="danger"
          type="button"
          onClick={anonymize}
          disabled={busy || status?.anonymization_eligible !== true}
          data-testid="customer-privacy-anonymize"
        >
          不可逆匿名化
        </Button>
      </div>

      <div className="ld-customer-privacy__events" data-testid="customer-privacy-events">
        <h4>最近隐私操作</h4>
        {events.length === 0 ? (
          <p>暂无记录</p>
        ) : (
          <ul>
            {events.map((event) => (
              <li key={event.event_id}>
                {event.action === "exported" ? "已导出" : "已匿名化"} · {event.reason} ·{" "}
                {event.affected_order_count} 笔订单
              </li>
            ))}
          </ul>
        )}
      </div>

      {pending !== null && authClient !== undefined && session !== undefined ? (
        <StepUpConfirmDialog
          open
          onClose={() => setPending(null)}
          authClient={authClient}
          confirmRef={pending.confirmRef}
          currentStaffId={session.session.staff_id}
          commandLabel={pending.label}
          requiredApproverRole="admin"
          onApproved={() => void resume()}
        />
      ) : null}
    </section>
  );
}
