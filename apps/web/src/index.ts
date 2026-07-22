/**
 * @laundry/web — counter SPA shell (M1).
 * E1: login + PIN quick-switch; session memory-only.
 * E3: permission route gate (role × store_features UI projection; C8 enforces).
 * R5: settings step-up PIN confirm (confirm_ref resume; actor unchanged).
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
export { StepUpConfirmDialog, type StepUpConfirmDialogProps } from "./shell/StepUpConfirmDialog.js";
export { PageHost, type PageHostProps } from "./pages/PageHost.js";
export { SettingsPage, type SettingsPageProps } from "./pages/SettingsPage.js";
export { ReceivePage, type ReceivePageProps } from "./pages/ReceivePage.js";
export { PickupPage, type PickupPageProps } from "./pages/PickupPage.js";
export { LoginPage, type LoginPageProps } from "./pages/LoginPage.js";
export { pageCopy, type PageCopy } from "./pages/page-copy.js";
export {
  createMockAuthClient,
  type AuthClient,
  type MockAuthClientOptions,
} from "./auth/AuthClient.js";
export { createHttpAuthClient, type HttpAuthClientOptions } from "./auth/HttpAuthClient.js";
export {
  createHttpCommandClient,
  createMockCommandClient,
  isStepUpRequired,
  type HttpCommandClientOptions,
} from "./commands/command-client.js";
export {
  createHttpQueryClient,
  createMockQueryClient,
  DEMO_CATALOG_ITEMS,
  type CatalogListItem,
  type CatalogListResult,
  type HttpQueryClientOptions,
} from "./commands/query-client.js";
export type { CommandFailure, CommandPort, CommandResult, QueryPort } from "./commands/types.js";
export type {
  AccessSession,
  AuthError,
  AuthResult,
  LoginFormValues,
  LoginRequest,
  PinChallengeRequest,
  PinChallengeResponse,
  PinVerifyRequest,
  StepUpProofResult,
  SwitchableStaff,
} from "./auth/types.js";
export {
  FULL_STORE_FEATURES,
  STAFF_STORE_FEATURES,
  STORE_FEATURE_KEYS,
  NAV_ACCESS_RULES,
  allowedNavKeys,
  defaultAllowedNavId,
  filterNavItems,
  hasFeature,
  isNavAllowed,
  isRuleSatisfied,
  permissionContextFrom,
  type NavAccessRule,
  type PermissionContext,
  type StaffRole,
  type StoreFeatureFlags,
  type StoreFeatureKey,
} from "./auth/permissions.js";
export {
  DENIED_PAGE_COPY,
  canOpenRoute,
  resolveRouteGate,
  visibleNavItems,
  type DeniedPageCopy,
  type RouteGateDecision,
} from "./routing/route-gate.js";
export { RouteGate, type RouteGateProps } from "./routing/RouteGate.js";
export {
  hasLoginFieldErrors,
  validateLoginForm,
  type LoginFieldErrors,
} from "./auth/validate-login.js";
export { validatePin } from "./auth/validate-pin.js";
export { assertNoAuthSecretsInWebStorage, webStorageHasAuthSecrets } from "./auth/storage-guard.js";
export { getDeviceId } from "./auth/device-id.js";
export { webConfig, type WebConfig } from "./config.js";
