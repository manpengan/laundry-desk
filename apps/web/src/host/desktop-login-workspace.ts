import type { LoginWorkspace } from "../auth/login-memory.js";

/**
 * The desktop renderer only reaches the bundled local Runtime, whose commissioned
 * profile has exactly one organization and store (apps/server/src/local/profile.ts).
 * Binding them here leaves the counter login with just 用户名 and 密码.
 */
export const DESKTOP_LOGIN_WORKSPACE: LoginWorkspace = Object.freeze({
  org_code: "local",
  store_code: "main",
});
