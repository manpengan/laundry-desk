import { Button, Input, useToast } from "@laundry/ui";
import { useCallback, useEffect, useState } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import { DangerConfirmDialog } from "./DangerConfirmDialog.js";
import { parseCustomerRows, type CustomerRowView, unwrapQueryResult } from "./customer-model.js";

type PendingAction = Readonly<{
  confirmRef: string;
  command: "customer.update" | "customer.merge";
  label: string;
  kind: "confirm" | "step_up";
}>;

export type CustomerGovernancePanelProps = Readonly<{
  customer: CustomerRowView;
  queryClient: QueryPort;
  commandClient: CommandPort;
  authClient?: AuthClient;
  session?: SessionView;
  onUpdated: () => void;
  onMerged: () => void;
}>;

const PHONE_RE = /^1[3-9]\d{9}$/u;

export function CustomerGovernancePanel({
  customer,
  queryClient,
  commandClient,
  authClient,
  session,
  onUpdated,
  onMerged,
}: CustomerGovernancePanelProps) {
  const toast = useToast();
  const [phone, setPhone] = useState(customer.phone);
  const [name, setName] = useState(customer.name ?? "");
  const [note, setNote] = useState(customer.note ?? "");
  const [duplicates, setDuplicates] = useState<readonly CustomerRowView[]>([]);
  const [targetId, setTargetId] = useState("");
  const [mergeReason, setMergeReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);

  useEffect(() => {
    setPhone(customer.phone);
    setName(customer.name ?? "");
    setNote(customer.note ?? "");
    setDuplicates([]);
    setTargetId("");
    setMergeReason("");
    setPending(null);
  }, [customer]);

  const loadDuplicates = useCallback(async () => {
    setBusy(true);
    try {
      const result = await queryClient.execute<unknown>("customer.duplicates", {
        customer_id: customer.customer_id,
        limit: 20,
      });
      if (!result.ok) {
        toast.push(result.error.message ?? result.error.code, "error");
        return;
      }
      const parsed = parseCustomerRows(unwrapQueryResult(result.data));
      if (parsed === null) {
        toast.push("重复客户候选无法解析", "error");
        return;
      }
      setDuplicates(parsed);
      setTargetId((current) =>
        parsed.some((candidate) => candidate.customer_id === current)
          ? current
          : (parsed[0]?.customer_id ?? ""),
      );
      if (parsed.length === 0) toast.push("未发现同名重复客户", "success");
    } finally {
      setBusy(false);
    }
  }, [customer.customer_id, queryClient, toast]);

  const execute = useCallback(
    async (
      command: PendingAction["command"],
      body: Readonly<Record<string, unknown>>,
      label: string,
    ) => {
      setBusy(true);
      try {
        const result = await commandClient.execute<unknown>(command, body);
        if (result.ok) {
          toast.push(`${label}完成`, "success");
          if (command === "customer.merge") onMerged();
          else onUpdated();
          return;
        }
        if (isStepUpRequired(result)) {
          setPending(
            Object.freeze({
              confirmRef: result.error.detail.confirm_ref,
              command,
              label,
              kind: result.error.code === "POLICY_STEP_UP_REQUIRED" ? "step_up" : "confirm",
            }),
          );
          return;
        }
        toast.push(result.error.message ?? result.error.code, "error");
      } finally {
        setBusy(false);
      }
    },
    [commandClient, onMerged, onUpdated, toast],
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
      const command = pending.command;
      setPending(null);
      if (command === "customer.merge") onMerged();
      else onUpdated();
    } finally {
      setBusy(false);
    }
  }, [commandClient, onMerged, onUpdated, pending, toast]);

  const save = useCallback(() => {
    const nextPhone = phone.trim();
    if (!PHONE_RE.test(nextPhone)) {
      toast.push("请输入有效的 11 位手机号", "error");
      return;
    }
    const body: Record<string, unknown> = { customer_id: customer.customer_id };
    if (nextPhone !== customer.phone) body.phone = nextPhone;
    const nextName = name.trim();
    if (nextName !== (customer.name ?? "")) body.name = nextName.length === 0 ? null : nextName;
    const nextNote = note.trim();
    if (nextNote !== (customer.note ?? "")) body.note = nextNote.length === 0 ? null : nextNote;
    if (Object.keys(body).length === 1) {
      toast.push("客户资料没有变化", "error");
      return;
    }
    void execute("customer.update", body, "客户资料更新");
  }, [customer, execute, name, note, phone, toast]);

  const merge = useCallback(() => {
    const reason = mergeReason.trim();
    if (targetId.length === 0 || reason.length === 0) {
      toast.push("请选择保留客户并填写合并原因", "error");
      return;
    }
    void execute(
      "customer.merge",
      {
        source_customer_id: customer.customer_id,
        target_customer_id: targetId,
        reason,
      },
      "重复客户合并",
    );
  }, [customer.customer_id, execute, mergeReason, targetId, toast]);

  return (
    <section className="ld-customer-governance" aria-label="客户资料治理">
      <h3>编辑资料</h3>
      <div className="ld-customer-governance__fields">
        <Input
          name="customer-edit-phone"
          label="手机号"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          disabled={busy}
        />
        <Input
          name="customer-edit-name"
          label="姓名"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
        />
        <label>
          <span>内部备注</span>
          <textarea
            name="customer-edit-note"
            value={note}
            maxLength={256}
            onChange={(event) => setNote(event.target.value)}
            disabled={busy}
          />
        </label>
      </div>
      <Button variant="secondary" type="button" onClick={save} disabled={busy}>
        保存修改
      </Button>

      <div className="ld-customer-governance__duplicates">
        <div>
          <h3>重复客户</h3>
          <p>仅显示同名候选，列表手机号保持脱敏；合并需另一位员工现场复核。</p>
        </div>
        <Button variant="ghost" type="button" onClick={() => void loadDuplicates()} disabled={busy}>
          检查重复
        </Button>
      </div>
      {duplicates.length > 0 ? (
        <div className="ld-customer-governance__merge">
          <label>
            <span>保留客户</span>
            <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              {duplicates.map((candidate) => (
                <option key={candidate.customer_id} value={candidate.customer_id}>
                  {candidate.name ?? "未命名"} · {candidate.phone}
                </option>
              ))}
            </select>
          </label>
          <Input
            name="customer-merge-reason"
            label="合并原因"
            value={mergeReason}
            onChange={(event) => setMergeReason(event.target.value)}
          />
          <Button variant="danger" type="button" onClick={merge} disabled={busy}>
            合并到保留客户
          </Button>
        </div>
      ) : null}

      <DangerConfirmDialog
        open={pending?.kind === "confirm"}
        title="确认修改客户资料"
        description="服务端已冻结本次资料变更，继续后会写入审计记录。"
        confirmLabel="确认保存"
        serverConfirmation
        busy={busy}
        onClose={() => setPending(null)}
        onConfirm={() => void resumePending()}
      />
      {pending?.kind === "step_up" && authClient !== undefined && session !== undefined ? (
        <StepUpConfirmDialog
          open
          onClose={() => setPending(null)}
          authClient={authClient}
          confirmRef={pending.confirmRef}
          currentStaffId={session.session.staff_id}
          commandLabel={pending.label}
          onApproved={() => void resumePending()}
        />
      ) : null}
    </section>
  );
}
