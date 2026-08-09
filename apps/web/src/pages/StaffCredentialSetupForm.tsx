import { Button, Input, useToast } from "@laundry/ui";
import { useCallback, useState, type FormEvent } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import {
  buildCredentialCompletion,
  type StaffCredentialDraft,
  type StaffCredentialSetup,
} from "./staff-credentials.js";

export type StaffCredentialSetupFormProps = Readonly<{
  setup: StaffCredentialSetup;
  authClient: AuthClient;
  onCompleted: (session: SessionView | null) => void | Promise<void>;
  onCancel: () => void;
}>;

const EMPTY_DRAFT: StaffCredentialDraft = Object.freeze({
  password: "",
  password_confirmation: "",
  pin: "",
  pin_confirmation: "",
});

function focusCredentialField(field: string): void {
  queueMicrotask(() => document.getElementById(`staff-credential-${field}`)?.focus());
}

export function StaffCredentialSetupForm({
  setup,
  authClient,
  onCompleted,
  onCancel,
}: StaffCredentialSetupFormProps) {
  const toast = useToast();
  const [draft, setDraft] = useState<StaffCredentialDraft>(EMPTY_DRAFT);
  const [fieldError, setFieldError] = useState<Readonly<{ field: string; message: string }> | null>(
    null,
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const patch = useCallback((next: Partial<StaffCredentialDraft>) => {
    setDraft((current) => Object.freeze({ ...current, ...next }));
    setFieldError(null);
    setFormError(null);
  }, []);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const built = buildCredentialCompletion(setup.credential_setup_ref, draft);
      if (!built.ok) {
        setFieldError(Object.freeze({ field: built.field, message: built.message }));
        focusCredentialField(built.field);
        return;
      }
      setBusy(true);
      setFormError(null);
      try {
        const completed = await authClient.completeStaffCredentials(built.body);
        setDraft(EMPTY_DRAFT);
        if (!completed.ok) {
          setFormError(completed.error.message);
          toast.push(completed.error.message, "error");
          focusCredentialField("password");
          return;
        }
        const refreshed = await authClient.refreshSession();
        if (!refreshed.ok) {
          await authClient.logout();
          toast.push("凭据已生效，但登录状态刷新失败，请重新登录", "error");
          await onCompleted(null);
          return;
        }
        toast.push("员工凭据已设置并启用", "success");
        await onCompleted(refreshed.data);
      } finally {
        setBusy(false);
      }
    },
    [authClient, draft, onCompleted, setup.credential_setup_ref, toast],
  );

  const errorFor = (field: string): string | undefined =>
    fieldError?.field === field ? fieldError.message : undefined;
  const errorProps = (
    field: string,
  ): Readonly<{ error: string }> | Readonly<Record<never, never>> => {
    const error = errorFor(field);
    return error === undefined ? Object.freeze({}) : Object.freeze({ error });
  };

  return (
    <form
      className="ld-settings-form ld-staff-credential-form"
      onSubmit={(event) => void submit(event)}
    >
      <h3>设置员工凭据</h3>
      <p className="ld-shell-main__hint">
        凭据设置链接将在 {new Date(setup.expires_at * 1_000).toLocaleString()} 失效。密码与 PIN
        只发送到本次受控完成接口。
      </p>
      <div
        className="ld-staff-form__error"
        role="alert"
        aria-live="assertive"
        hidden={fieldError === null && formError === null}
      >
        {fieldError?.message ?? formError ?? ""}
      </div>
      <Input
        id="staff-credential-password"
        name="staff-credential-password"
        label="新密码"
        type="password"
        autoComplete="new-password"
        minLength={12}
        maxLength={256}
        value={draft.password}
        onChange={(event) => patch({ password: event.target.value })}
        {...errorProps("password")}
        disabled={busy}
      />
      <Input
        id="staff-credential-password_confirmation"
        name="staff-credential-password-confirmation"
        label="再次输入新密码"
        type="password"
        autoComplete="new-password"
        value={draft.password_confirmation}
        onChange={(event) => patch({ password_confirmation: event.target.value })}
        {...errorProps("password_confirmation")}
        disabled={busy}
      />
      <Input
        id="staff-credential-pin"
        name="staff-credential-pin"
        label="新 PIN（6–8 位数字）"
        type="password"
        inputMode="numeric"
        autoComplete="new-password"
        pattern="[0-9]{6,8}"
        minLength={6}
        maxLength={8}
        value={draft.pin}
        onChange={(event) => patch({ pin: event.target.value })}
        {...errorProps("pin")}
        disabled={busy}
      />
      <Input
        id="staff-credential-pin_confirmation"
        name="staff-credential-pin-confirmation"
        label="再次输入新 PIN"
        type="password"
        inputMode="numeric"
        autoComplete="new-password"
        pattern="[0-9]{6,8}"
        value={draft.pin_confirmation}
        onChange={(event) => patch({ pin_confirmation: event.target.value })}
        {...errorProps("pin_confirmation")}
        disabled={busy}
      />
      <div className="ld-settings-form__actions">
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? "启用中…" : "设置并启用"}
        </Button>
        <Button variant="ghost" type="button" disabled={busy} onClick={onCancel}>
          稍后设置
        </Button>
      </div>
    </form>
  );
}
