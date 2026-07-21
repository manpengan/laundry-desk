/**
 * @laundry/web — counter SPA shell (M1).
 * E1: login + PIN quick-switch; session memory-only. E3 route gates still pending.
 */
export {
  connectionModeLabel,
  connectionTone,
  createMockConnection,
  formatConnectionStrip,
  type ConnectionMode,
  type ConnectionStatus,
} from "./connection.js";
export {
  applyThemeToDocument,
  cycleThemePreference,
  resolveTheme,
  themePreferenceLabel,
  type ResolvedTheme,
  type ThemePreference,
} from "./theme.js";
export { COUNTER_NAV, navLabel, type NavItem, type NavItemId } from "./nav.js";
export { App, type AppProps } from "./App.js";
export { CounterShell, type CounterShellProps } from "./shell/CounterShell.js";
export { Sidebar, type SidebarProps } from "./shell/Sidebar.js";
export { TopBar, type TopBarProps } from "./shell/TopBar.js";
export { PinSwitchDialog, type PinSwitchDialogProps } from "./shell/PinSwitchDialog.js";
export { PageHost, type PageHostProps } from "./pages/PageHost.js";
export { LoginPage, type LoginPageProps } from "./pages/LoginPage.js";
export { pageCopy, type PageCopy } from "./pages/page-copy.js";
export {
  createMockAuthClient,
  type AuthClient,
  type MockAuthClientOptions,
} from "./auth/AuthClient.js";
export type {
  AccessSession,
  AuthError,
  AuthResult,
  LoginFormValues,
  LoginRequest,
  PinChallengeRequest,
  PinChallengeResponse,
  PinVerifyRequest,
  SwitchableStaff,
} from "./auth/types.js";
export {
  hasLoginFieldErrors,
  validateLoginForm,
  type LoginFieldErrors,
} from "./auth/validate-login.js";
export { validatePin } from "./auth/validate-pin.js";
export { assertNoAuthSecretsInWebStorage, webStorageHasAuthSecrets } from "./auth/storage-guard.js";
export { getDeviceId } from "./auth/device-id.js";
export { webConfig, type WebConfig } from "./config.js";
