import { Button, Input, useToast } from "@laundry/ui";
import { useCallback, useState, type FormEvent } from "react";
import type { AuthClient } from "../auth/AuthClient.js";
import type { AccessSession, LoginFormValues } from "../auth/types.js";
import { hasLoginFieldErrors, validateLoginForm } from "../auth/validate-login.js";

export type LoginPageProps = {
  authClient: AuthClient;
  onSuccess: (session: AccessSession) => void;
  /** Optional prefill (local host demo only — never bake secrets into library defaults). */
  initialForm?: Partial<LoginFormValues>;
};

const EMPTY_FORM: LoginFormValues = {
  org_code: "",
  store_code: "",
  username: "",
  password: "",
};

function mergeForm(initial?: Partial<LoginFormValues>): LoginFormValues {
  if (initial === undefined) return EMPTY_FORM;
  return {
    org_code: initial.org_code ?? "",
    store_code: initial.store_code ?? "",
    username: initial.username ?? "",
    password: initial.password ?? "",
  };
}

export function LoginPage({ authClient, onSuccess, initialForm }: LoginPageProps) {
  const toast = useToast();
  const [form, setForm] = useState<LoginFormValues>(() => mergeForm(initialForm));
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof LoginFormValues, string>>>(
    {},
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const setField = useCallback((key: keyof LoginFormValues, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
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
      setSubmitting(true);
      try {
        const result = await authClient.login(form);
        if (!result.ok) {
          setFormError(result.error.message);
          toast.push(result.error.message, "error");
          return;
        }
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
          <h1 className="ld-login__title">柜台登录</h1>
          <p className="ld-login__hint">使用机构 / 门店代码与员工账号进入柜台</p>
        </header>
        <form className="ld-login__form" onSubmit={(e) => void onSubmit(e)} noValidate>
          <Input
            name="org_code"
            label="机构代码"
            autoComplete="organization"
            value={form.org_code}
            onChange={(e) => setField("org_code", e.target.value)}
            {...(fieldErrors.org_code ? { error: fieldErrors.org_code } : {})}
            disabled={submitting}
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
          <Input
            name="username"
            label="用户名"
            autoComplete="username"
            value={form.username}
            onChange={(e) => setField("username", e.target.value)}
            {...(fieldErrors.username ? { error: fieldErrors.username } : {})}
            disabled={submitting}
          />
          <Input
            name="password"
            label="密码"
            type="password"
            autoComplete="current-password"
            value={form.password}
            onChange={(e) => setField("password", e.target.value)}
            {...(fieldErrors.password ? { error: fieldErrors.password } : {})}
            disabled={submitting}
          />
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
