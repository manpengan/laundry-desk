/**
 * @laundry/web — counter SPA shell skeleton (M1).
 * No auth (E1) / route gates (E3) yet — layout + theme + connection strip only.
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
export { PageHost, type PageHostProps } from "./pages/PageHost.js";
export { pageCopy, type PageCopy } from "./pages/page-copy.js";
