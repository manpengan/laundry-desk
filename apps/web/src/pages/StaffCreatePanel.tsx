import { Button, Input, useToast } from "@laundry/ui";
import { useCallback, useState, type FormEvent } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort } from "../commands/types.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import { StaffCredentialSetupForm } from "./StaffCredentialSetupForm.js";
import {
  buildStaffCreateBody,
  parseStaffCredentialSetup,
  type StaffCreateDraft,
  type StaffCredentialSetup,
} from "./staff-credentials.js";

export type StaffCreatePanelProps = Readonly<{
  currentStaffId: string;
  authClient: AuthClient;
  commandClient: CommandPort;
  onMutation: (session: SessionView) => void | Promise<void>;
  onAuthenticationLost: () => void | Promise<void>;
}>;

const EMPTY_CREATE: StaffCreateDraft = Object.freeze({
  username: "",
  display_name: "",
  role: "staff",
  privacy_admin: false,
  reason: "",
});

function focusCreateField(field: string): void {
  queueMicrotask(() => document.getElementById(`staff-create-${field}`)?.focus());
}

export function StaffCreatePanel(props: StaffCreatePanelProps) {
  const { currentStaffId, authClient, commandClient, onMutation, onAuthenticationLost } = props;
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<StaffCreateDraft>(EMPTY_CREATE);
  const [fieldError, setFieldError] = useState<Readonly<{ field: string; message: string }> | null>(
    null,
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingRef, setPendingRef] = useState<string | null>(null);
  const [setup, setSetup] = useState<StaffCredentialSetup | null>(null);
  const [busy, setBusy] = useState(false);

  const patch = useCallback((next: Partial<StaffCreateDraft>) => {
    setDraft((current) => Object.freeze({ ...current, ...next }));
    setFieldError(null);
    setFormError(null);
  }, []);

  const execute = useCallback(
    async (confirmRef?: string) => {
      const built = buildStaffCreateBody(draft);
      if (!built.ok) {
        setFieldError(Object.freeze({ field: built.field, message: built.message }));
        focusCreateField(built.field);
        return;
      }
      setBusy(true);
      try {
        const result = await commandClient.execute<unknown>(
          "staff.create",
          built.body,
          confirmRef === undefined ? {} : { confirmRef },
        );
        if (isStepUpRequired(result)) {
          setPendingRef(result.error.detail.confirm_ref);
          return;
        }
        if (!result.ok) {
          setFormError(result.error.message ?? result.error.code);
          return;
        }
        const parsed = parseStaffCredentialSetup(result.data);
        if (parsed === null) {
          setFormError("员工创建响应格式错误");
          return;
        }
        const refreshed = await authClient.refreshSession();
        if (!refreshed.ok) {
          await authClient.logout();
          await onAuthenticationLost();
          return;
        }
        await onMutation(refreshed.data);
        setSetup(parsed);
        setDraft(EMPTY_CREATE);
        setOpen(false);
        toast.push("员工已创建，请设置独立凭据", "success");
      } finally {
        setBusy(false);
      }
    },
    [authClient, commandClient, draft, onAuthenticationLost, onMutation, toast],
  );

  return (
    <div className="ld-staff-create" data-testid="staff-create">
      {open ? (
        <form
          className="ld-settings-form"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void execute();
          }}
        >
          <h3>新增员工</h3>
          <div
            className="ld-staff-form__error"
            role="alert"
            aria-live="assertive"
            hidden={fieldError === null && formError === null}
          >
            {fieldError?.message ?? formError ?? ""}
          </div>
          <Input
            id="staff-create-username"
            name="staff-create-username"
            label="登录名"
            value={draft.username}
            onChange={(event) => patch({ username: event.target.value })}
            {...(fieldError?.field === "username" ? { error: fieldError.message } : {})}
            disabled={busy}
          />
          <Input
            id="staff-create-display_name"
            name="staff-create-display-name"
            label="员工姓名"
            value={draft.display_name}
            onChange={(event) => patch({ display_name: event.target.value })}
            {...(fieldError?.field === "display_name" ? { error: fieldError.message } : {})}
            disabled={busy}
          />
          <label className="ld-staff-form__field">
            角色
            <select
              id="staff-create-role"
              value={draft.role}
              disabled={busy}
              onChange={(event) =>
                patch({
                  role: event.target.value === "admin" ? "admin" : "staff",
                  ...(event.target.value === "staff" ? { privacy_admin: false } : {}),
                })
              }
            >
              <option value="staff">店员</option>
              <option value="admin">店长</option>
            </select>
          </label>
          <label className="ld-staff-form__check">
            <input
              type="checkbox"
              checked={draft.privacy_admin}
              disabled={busy || draft.role !== "admin"}
              onChange={(event) => patch({ privacy_admin: event.target.checked })}
            />
            隐私管理员
          </label>
          <Input
            id="staff-create-reason"
            name="staff-create-reason"
            label="新增原因"
            value={draft.reason}
            onChange={(event) => patch({ reason: event.target.value })}
            {...(fieldError?.field === "reason" ? { error: fieldError.message } : {})}
            disabled={busy}
          />
          <div className="ld-settings-form__actions">
            <Button type="submit" disabled={busy}>
              提交并复核
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              取消
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="secondary" onClick={() => setOpen(true)}>
          新增员工
        </Button>
      )}
      {setup === null ? null : (
        <StaffCredentialSetupForm
          setup={setup}
          authClient={authClient}
          onCancel={() => setSetup(null)}
          onCompleted={async (session) => {
            setSetup(null);
            if (session === null) await onAuthenticationLost();
            else await onMutation(session);
          }}
        />
      )}
      <StepUpConfirmDialog
        open={pendingRef !== null}
        onClose={() => setPendingRef(null)}
        authClient={authClient}
        confirmRef={pendingRef ?? ""}
        currentStaffId={currentStaffId}
        commandLabel="新增员工"
        summary={
          <p>
            新增 @{draft.username}（{draft.role === "admin" ? "店长" : "店员"}）
          </p>
        }
        onApproved={() => {
          const ref = pendingRef;
          setPendingRef(null);
          if (ref !== null) void execute(ref);
        }}
      />
    </div>
  );
}
