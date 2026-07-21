import type { LoginFormValues } from "./types.js";

export type LoginFieldErrors = Partial<Record<keyof LoginFormValues, string>>;

const VISIBLE_ASCII = /^[\x21-\x7E]{1,128}$/u;

function isVisibleCode(value: string): boolean {
  return VISIBLE_ASCII.test(value);
}

/**
 * Client-side gate before AuthClient.login.
 * Does not log or return the password value.
 */
export function validateLoginForm(values: LoginFormValues): LoginFieldErrors {
  const errors: LoginFieldErrors = {};

  if (values.org_code.trim() === "") {
    errors.org_code = "请填写机构代码";
  } else if (!isVisibleCode(values.org_code.trim())) {
    errors.org_code = "机构代码格式无效";
  }

  if (values.store_code.trim() === "") {
    errors.store_code = "请填写门店代码";
  } else if (!isVisibleCode(values.store_code.trim())) {
    errors.store_code = "门店代码格式无效";
  }

  if (values.username.trim() === "") {
    errors.username = "请填写用户名";
  } else if (!isVisibleCode(values.username.trim())) {
    errors.username = "用户名格式无效";
  }

  if (values.password === "") {
    errors.password = "请填写密码";
  } else if (values.password.length > 1024) {
    errors.password = "密码过长";
  }

  return errors;
}

export function hasLoginFieldErrors(errors: LoginFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}
