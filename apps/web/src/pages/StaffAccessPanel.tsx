import { Button, Input, useToast } from "@laundry/ui";
import { useCallback, useEffect, useState } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import { parseStaffAccessRows, type StaffAccessView } from "./staff-access.js";
import { StaffCreatePanel } from "./StaffCreatePanel.js";
import { StaffCredentialResetPanel } from "./StaffCredentialResetPanel.js";

export type StaffAccessPanelProps = Readonly<{
  currentStaffId: string;
  authClient: AuthClient;
  commandClient: CommandPort;
  queryClient?: QueryPort;
  onSessionChange?: (session: SessionView | null) => void;
}>;

type Draft = Readonly<{
  row: StaffAccessView;
  role: "admin" | "staff";
  privacy_admin: boolean;
  is_active: boolean;
  reason: string;
}>;

const draftFor = (row: StaffAccessView): Draft =>
  Object.freeze({
    row,
    role: row.role,
    privacy_admin: row.privacy_admin,
    is_active: row.is_active,
    reason: "",
  });

export function StaffAccessPanel({
  currentStaffId,
  authClient,
  commandClient,
  queryClient,
  onSessionChange = () => undefined,
}: StaffAccessPanelProps) {
  const toast = useToast();
  const [rows, setRows] = useState<readonly StaffAccessView[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingRef, setPendingRef] = useState<string | null>(null);
  const [resetRow, setResetRow] = useState<StaffAccessView | null>(null);

  const reload = useCallback(async () => {
    if (queryClient === undefined) return;
    const response = await queryClient.execute<unknown>("staff.access.list", {});
    const parsed = response.ok ? parseStaffAccessRows(response.data) : null;
    if (parsed === null) {
      toast.push(
        response.ok ? "员工权限数据无效" : (response.error.message ?? "读取员工失败"),
        "error",
      );
      return;
    }
    setRows(parsed);
  }, [queryClient, toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const patchDraft = useCallback((patch: Partial<Omit<Draft, "row">>) => {
    setDraft((current) => (current === null ? null : Object.freeze({ ...current, ...patch })));
  }, []);

  const submit = useCallback(
    async (confirmRef?: string) => {
      if (draft === null) return;
      if (draft.reason.trim().length === 0) {
        toast.push("请填写权限变更原因", "error");
        return;
      }
      setBusy(true);
      try {
        const result = await commandClient.execute(
          "staff.access.set",
          {
            target_staff_id: draft.row.staff_id,
            expected_permission_version: draft.row.permission_version,
            role: draft.role,
            privacy_admin: draft.privacy_admin,
            is_active: draft.is_active,
            reason: draft.reason.trim(),
          },
          confirmRef === undefined ? {} : { confirmRef },
        );
        if (isStepUpRequired(result)) {
          setPendingRef(result.error.detail.confirm_ref);
          return;
        }
        if (!result.ok) {
          toast.push(result.error.message ?? result.error.code, "error");
          return;
        }
        toast.push("员工权限已更新，原会话已撤销", "success");
        setDraft(null);
        await reload();
      } finally {
        setBusy(false);
      }
    },
    [commandClient, draft, reload, toast],
  );

  return (
    <section
      className="ld-settings-catalog lg-card"
      aria-label="员工与权限"
      data-testid="staff-access"
    >
      <h2 className="ld-shell-main__title">员工与权限</h2>
      <p className="ld-shell-main__hint">
        角色、在职状态及隐私管理员均为 R5 变更；必须由另一位店长 PIN
        复核，并立即撤销目标员工旧会话。
      </p>
      <StaffCreatePanel
        currentStaffId={currentStaffId}
        authClient={authClient}
        commandClient={commandClient}
        onMutation={async (session) => {
          onSessionChange(session);
          await reload();
        }}
        onAuthenticationLost={() => onSessionChange(null)}
      />
      <ul className="ld-settings-catalog__list" data-testid="staff-access-list">
        {rows.map((row) => (
          <li key={row.staff_id} className="ld-settings-catalog__row">
            <span className="ld-settings-catalog__name">{row.display_name}</span>
            <span className="ld-settings-catalog__code">@{row.username}</span>
            <span>{row.role === "admin" ? "店长" : "店员"}</span>
            <span>{row.privacy_admin ? "隐私管理员" : "无隐私权限"}</span>
            <span>{row.is_active ? "在职" : "停用"}</span>
            <Button
              variant="ghost"
              type="button"
              disabled={busy || row.staff_id === currentStaffId}
              onClick={() => setDraft(draftFor(row))}
            >
              {row.staff_id === currentStaffId ? "不可自改" : "编辑"}
            </Button>
            <Button
              variant="ghost"
              type="button"
              disabled={busy || row.staff_id === currentStaffId}
              onClick={() => setResetRow(row)}
            >
              重置凭据
            </Button>
          </li>
        ))}
      </ul>

      {draft !== null ? (
        <div className="ld-settings-form" data-testid="staff-access-editor">
          <label>
            角色
            <select
              value={draft.role}
              disabled={busy}
              onChange={(event) => {
                const role = event.target.value === "admin" ? "admin" : "staff";
                patchDraft({
                  role,
                  ...(role === "staff" ? { privacy_admin: false } : {}),
                });
              }}
            >
              <option value="staff">店员</option>
              <option value="admin">店长</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={draft.privacy_admin}
              disabled={busy || draft.role !== "admin" || !draft.is_active}
              onChange={(event) => patchDraft({ privacy_admin: event.target.checked })}
            />
            隐私管理员
          </label>
          <label>
            <input
              type="checkbox"
              checked={draft.is_active}
              disabled={busy}
              onChange={(event) =>
                patchDraft({
                  is_active: event.target.checked,
                  ...(event.target.checked ? {} : { privacy_admin: false }),
                })
              }
            />
            在职
          </label>
          <Input
            name="staff-access-reason"
            label="变更原因"
            value={draft.reason}
            disabled={busy}
            onChange={(event) => patchDraft({ reason: event.target.value })}
          />
          <div className="ld-settings-form__actions">
            <Button type="button" variant="primary" disabled={busy} onClick={() => void submit()}>
              提交并复核
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
              取消
            </Button>
          </div>
        </div>
      ) : null}

      {resetRow === null ? null : (
        <StaffCredentialResetPanel
          row={resetRow}
          currentStaffId={currentStaffId}
          authClient={authClient}
          commandClient={commandClient}
          onClose={() => setResetRow(null)}
          onMutation={async (session) => {
            onSessionChange(session);
            await reload();
          }}
          onAuthenticationLost={() => onSessionChange(null)}
        />
      )}

      <StepUpConfirmDialog
        open={pendingRef !== null}
        onClose={() => setPendingRef(null)}
        authClient={authClient}
        confirmRef={pendingRef ?? ""}
        currentStaffId={currentStaffId}
        commandLabel="修改员工权限"
        onApproved={() => {
          const ref = pendingRef;
          setPendingRef(null);
          if (ref !== null) void submit(ref);
        }}
      />
    </section>
  );
}
