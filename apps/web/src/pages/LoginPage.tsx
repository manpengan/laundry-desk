import { Button, Icon, Input, useToast } from "@laundry/ui";
import { useCallback, useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import type { AuthClient } from "../auth/AuthClient.js";
import {
  browserLoginStorage,
  readLoginWorkspace,
  rememberLoginWorkspace,
} from "../auth/login-memory.js";
import type { LoginFormValues, SessionView } from "../auth/types.js";
import { hasLoginFieldErrors, validateLoginForm } from "../auth/validate-login.js";

export type LoginPageProps = {
  authClient: Pick<AuthClient, "login">;
  onSuccess: (session: SessionView) => void;
  /** Optional prefill (local host demo only — never bake secrets into library defaults). */
  initialForm?: Partial<LoginFormValues>;
  title?: string;
  hint?: string;
};

const EMPTY_FORM: LoginFormValues = {
  org_code: "",
  store_code: "",
  username: "",
  password: "",
};

function mergeForm(initial?: Partial<LoginFormValues>): LoginFormValues {
  const remembered = readLoginWorkspace(browserLoginStorage());
  const base =
    remembered === null
      ? EMPTY_FORM
      : { ...EMPTY_FORM, org_code: remembered.org_code, store_code: remembered.store_code };
  if (initial === undefined) return base;
  return {
    org_code: initial.org_code ?? base.org_code,
    store_code: initial.store_code ?? base.store_code,
    username: initial.username ?? "",
    password: initial.password ?? "",
  };
}

export function LoginPage({
  authClient,
  onSuccess,
  initialForm,
  title = "柜台登录",
  hint = "使用机构 / 门店代码与员工账号进入柜台",
}: LoginPageProps) {
  const toast = useToast();
  const [form, setForm] = useState<LoginFormValues>(() => mergeForm(initialForm));
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof LoginFormValues, string>>>(
    {},
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const workspaceKnown = form.org_code.length > 0 && form.store_code.length > 0;

  useEffect(() => {
    if (typeof document !== "undefined") document.title = `${title} · 洗衣柜台`;
  }, [title]);

  const setField = useCallback((key: keyof LoginFormValues, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const trackCapsLock = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    setCapsLock(event.getModifierState("CapsLock"));
  }, []);

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setFormError(null);
      const errors = validateLoginForm(form);
      setFieldErrors(errors);
      if (hasLoginFieldErrors(errors)) {
        toast.push("请完善登录信息", "warning");
        return;
      }
      const credentials = Object.freeze({ ...form });
      setForm((previous) => ({ ...previous, password: "" }));
      setShowPassword(false);
      setSubmitting(true);
      try {
        const result = await authClient.login(credentials);
        if (!result.ok) {
          setFormError(result.error.message);
          return;
        }
        rememberLoginWorkspace(browserLoginStorage(), credentials);
        onSuccess(result.data);
      } finally {
        setSubmitting(false);
      }
    },
    [authClient, form, onSuccess, toast],
  );

  return (
    <div className="ld-login" data-page="login">
      <div className="ld-login__card lg-card">
        <header className="ld-login__header">
          <span className="ld-login__mark" aria-hidden="true">
            <Icon name="shirt" size={26} strokeWidth={2} />
          </span>
          <h1 className="ld-login__title">{title}</h1>
          <p className="ld-login__hint">{hint}</p>
        </header>
        <form className="ld-login__form" onSubmit={(e) => void onSubmit(e)} noValidate>
          <div className="ld-login__workspace">
            <Input
              name="org_code"
              label="机构代码"
              autoComplete="organization"
              value={form.org_code}
              onChange={(e) => setField("org_code", e.target.value)}
              {...(fieldErrors.org_code ? { error: fieldErrors.org_code } : {})}
              disabled={submitting}
              autoFocus={!workspaceKnown}
            />
            <Input
              name="store_code"
              label="门店代码"
              autoComplete="off"
              value={form.store_code}
              onChange={(e) => setField("store_code", e.target.value)}
              {...(fieldErrors.store_code ? { error: fieldErrors.store_code } : {})}
              disabled={submitting}
            />
          </div>
          <Input
            name="username"
            label="用户名"
            autoComplete="username"
            value={form.username}
            onChange={(e) => setField("username", e.target.value)}
            {...(fieldErrors.username ? { error: fieldErrors.username } : {})}
            disabled={submitting}
            autoFocus={workspaceKnown}
          />
          <div className="ld-login__password">
            <Input
              name="password"
              label="密码"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              value={form.password}
              onChange={(e) => setField("password", e.target.value)}
              onKeyDown={trackCapsLock}
              onKeyUp={trackCapsLock}
              {...(fieldErrors.password
                ? { error: fieldErrors.password }
                : capsLock
                  ? { hint: "大写锁定已开启" }
                  : {})}
              disabled={submitting}
            />
            <button
              type="button"
              className="ld-login__reveal"
              onClick={() => setShowPassword((value) => !value)}
              aria-label={showPassword ? "隐藏密码" : "显示密码"}
              aria-pressed={showPassword}
              disabled={submitting}
            >
              <Icon name={showPassword ? "eyeOff" : "eye"} size={18} />
            </button>
          </div>
          {formError ? (
            <div className="ld-login__error" role="alert">
              {formError}
            </div>
          ) : null}
          <Button type="submit" variant="primary" size="lg" disabled={submitting}>
            {submitting ? "登录中…" : "登录"}
          </Button>
        </form>
      </div>
    </div>
  );
}
