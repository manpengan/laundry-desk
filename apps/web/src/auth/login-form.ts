import { browserLoginStorage, readLoginWorkspace, type LoginWorkspace } from "./login-memory.js";
import type { LoginFormValues } from "./types.js";

const EMPTY_FORM: LoginFormValues = Object.freeze({
  org_code: "",
  store_code: "",
  username: "",
  password: "",
});

/**
 * Seeds the login form. A host-bound workspace replaces any remembered or prefilled
 * 机构 / 门店代码, so the page only asks for the staff account.
 */
export function initialLoginForm(
  initial: Partial<LoginFormValues> | undefined,
  workspace: LoginWorkspace | undefined,
  remembered: LoginWorkspace | null = readLoginWorkspace(browserLoginStorage()),
): LoginFormValues {
  const base =
    remembered === null
      ? EMPTY_FORM
      : { ...EMPTY_FORM, org_code: remembered.org_code, store_code: remembered.store_code };
  const merged =
    initial === undefined
      ? base
      : {
          org_code: initial.org_code ?? base.org_code,
          store_code: initial.store_code ?? base.store_code,
          username: initial.username ?? "",
          password: initial.password ?? "",
        };
  return Object.freeze(
    workspace === undefined
      ? { ...merged }
      : { ...merged, org_code: workspace.org_code, store_code: workspace.store_code },
  );
}
