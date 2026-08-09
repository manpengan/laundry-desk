import { Button, Input, useToast } from "@laundry/ui";
import { useCallback, useState, type FormEvent } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort } from "../commands/types.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import { StaffCredentialSetupForm } from "./StaffCredentialSetupForm.js";
import {
  buildStaffCredentialsResetBody,
  parseStaffCredentialSetup,
  type StaffCredentialSetup,
} from "./staff-credentials.js";
import type { StaffAccessView } from "./staff-access.js";

export type StaffCredentialResetPanelProps = Readonly<{
  row: StaffAccessView;
  currentStaffId: string;
  authClient: AuthClient;
  commandClient: CommandPort;
  onMutation: (session: SessionView) => void | Promise<void>;
  onAuthenticationLost: () => void | Promise<void>;
  onClose: () => void;
}>;

export function StaffCredentialResetPanel(props: StaffCredentialResetPanelProps) {
  const {
    row,
    currentStaffId,
    authClient,
    commandClient,
    onMutation,
    onAuthenticationLost,
    onClose,
  } = props;
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingRef, setPendingRef] = useState<string | null>(null);
  const [setup, setSetup] = useState<StaffCredentialSetup | null>(null);
  const [busy, setBusy] = useState(false);

  const execute = useCallback(
    async (confirmRef?: string) => {
      const built = buildStaffCredentialsResetBody({
        target_staff_id: row.staff_id,
        expected_permission_version: row.permission_version,
        reason,
      });
      if (!built.ok) {
        setError(built.message);
        if (built.field === "reason") {
          queueMicrotask(() => document.getElementById("staff-reset-reason")?.focus());
        }
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const result = await commandClient.execute<unknown>(
          "staff.credentials.reset",
          built.body,
          confirmRef === undefined ? {} : { confirmRef },
        );
        if (isStepUpRequired(result)) {
          setPendingRef(result.error.detail.confirm_ref);
          return;
        }
        if (!result.ok) {
          setError(result.error.message ?? result.error.code);
          return;
        }
        const parsed = parseStaffCredentialSetup(result.data);
        if (parsed === null) {
          setError("凭据重置响应格式错误");
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
        toast.push("旧凭据与会话已撤销，请设置新凭据", "success");
      } finally {
        setBusy(false);
      }
    },
    [authClient, commandClient, onAuthenticationLost, onMutation, reason, row, toast],
  );

  if (setup !== null) {
    return (
      <StaffCredentialSetupForm
        setup={setup}
        authClient={authClient}
        onCancel={onClose}
        onCompleted={async (session) => {
          if (session === null) await onAuthenticationLost();
          else await onMutation(session);
          onClose();
        }}
      />
    );
  }

  return (
    <div className="ld-settings-form" data-testid="staff-credential-reset">
      <h3>重置 {row.display_name} 的凭据</h3>
      <p className="ld-shell-main__hint">
        执行后立即停用旧密码、PIN 与全部会话，必须当场设置新凭据。
      </p>
      <div
        className="ld-staff-form__error"
        role="alert"
        aria-live="assertive"
        hidden={error === null}
      >
        {error ?? ""}
      </div>
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void execute();
        }}
      >
        <Input
          id="staff-reset-reason"
          name="staff-reset-reason"
          label="重置原因"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setError(null);
          }}
          disabled={busy}
          {...(error === null ? {} : { error })}
        />
        <div className="ld-settings-form__actions">
          <Button variant="danger" type="submit" disabled={busy}>
            {busy ? "提交中…" : "撤销并复核"}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Button>
        </div>
      </form>
      <StepUpConfirmDialog
        open={pendingRef !== null}
        onClose={() => setPendingRef(null)}
        authClient={authClient}
        confirmRef={pendingRef ?? ""}
        currentStaffId={currentStaffId}
        commandLabel="重置员工凭据"
        summary={<p>撤销 @{row.username} 的旧密码、PIN 与全部会话</p>}
        onApproved={() => {
          const ref = pendingRef;
          setPendingRef(null);
          if (ref !== null) void execute(ref);
        }}
      />
    </div>
  );
}
