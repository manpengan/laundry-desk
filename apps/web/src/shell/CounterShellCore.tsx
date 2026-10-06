import { useToastPageScope, type PrintJobSummary } from "@laundry/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import type { AuthClient } from "../auth/AuthClient.js";
import { filterNavItems, permissionContextFrom } from "../auth/permissions.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { type ConnectionStatus } from "../connection.js";
import type { AiPanelPort } from "../host/ai-port.js";
import type { AiSettingsPort } from "../ai/settings-port.js";
import type { ScalePort } from "../host/scale-port.js";
import type { StoreExportPort } from "../host/store-export-port.js";
import type { MaintenancePort } from "../host/maintenance-port.js";
import type { PaymentChannelPort } from "../host/payment-channel-port.js";
import type { MiniappSettingsPort } from "../host/miniapp-settings-port.js";
import type { RemoteAssistancePort } from "../host/remote-assistance-port.js";
import type { MigrationPort } from "../host/migration-port.js";
import type { NotificationSettingsPort } from "../host/notification-settings-port.js";
import type { OfflinePort } from "../host/offline-port.js";
import type { PhotoPort } from "../host/photo-port.js";
import type { PrinterPort } from "../host/printer-port.js";
import { navLabel, navTargetForDigit, type NavItemId } from "../nav.js";
import type {
  NavigationIntent,
  NavigationIntentInput,
  PageHostProps,
} from "../pages/PageHostCore.js";
import { RouteGate } from "../routing/RouteGate.js";
import {
  applyThemeToDocument,
  browserThemeStorage,
  initialCounterTheme,
  resolveTheme,
  writeStoredThemePreference,
  type ThemePreference,
} from "../theme.js";
import { AiPanel } from "./AiPanel.js";
import { CommandPalette } from "./CommandPalette.js";
import { lookupCommands } from "./command-palette-model.js";
import { PinSwitchDialog } from "./PinSwitchDialog.js";
import { PrintQueuePanel } from "./PrintQueuePanel.js";
import { ShortcutHelpDialog } from "./ShortcutHelpDialog.js";
import { shellCommands } from "./shell-commands.js";
import { ThemeControlContext, useShellShortcuts } from "./shell-shortcuts.js";
import { Sidebar } from "./Sidebar.js";
import { TopBar } from "./TopBar.js";
import type { HealthPort } from "../host/types.js";
import { ReceiveWorkspaceProvider, useReceiveWorkspaceAccess } from "../pages/ReceiveWorkspace.js";
import { hasReceiveWork } from "../pages/receive-workspace.js";
import { useLiveConnection } from "./use-live-connection.js";
import { usePrintJobSummary } from "./use-print-job-summary.js";
import { readSidebarExpanded, writeSidebarExpanded } from "./sidebar-preference.js";
import type { ReceiveRecoveryPort } from "../host/receive-recovery-port.js";

export type CounterShellProps = {
  session: SessionView;
  authClient: AuthClient;
  commandClient: CommandPort;
  queryClient: QueryPort;
  photoPort?: PhotoPort;
  receiveRecoveryPort?: ReceiveRecoveryPort;
  healthPort?: HealthPort;
  offlinePort?: OfflinePort;
  printerPort?: PrinterPort;
  aiPort?: AiPanelPort;
  aiSettingsPort?: AiSettingsPort;
  migrationPort?: MigrationPort;
  maintenancePort?: MaintenancePort;
  storeExportPort?: StoreExportPort;
  paymentChannelPort?: PaymentChannelPort;
  miniappSettingsPort?: MiniappSettingsPort;
  remoteAssistancePort?: RemoteAssistancePort;
  scalePort?: ScalePort;
  notificationSettingsPort?: NotificationSettingsPort;
  onSessionChange: (session: SessionView | null) => void;
  initialConnection?: ConnectionStatus;
  initialTheme?: ThemePreference;
  initialNav?: NavItemId;
  systemDark?: boolean;
  documentRef?: Pick<Document, "documentElement"> | null;
  /** Fixed indicator summary for tests; production polls the query client. */
  printSummary?: PrintJobSummary;
  /** Simulate first-paint skeleton once (ms). 0 = off. */
  initialLoadingMs?: number;
  readOnly?: boolean;
};

type CounterShellCoreProps = CounterShellProps &
  Readonly<{ PageHostComponent: ComponentType<PageHostProps> }>;

const READ_ONLY_COMMAND_PORT: CommandPort = Object.freeze({
  execute: async <T,>(): Promise<
    Readonly<
      { ok: true; data: T } | { ok: false; error: Readonly<{ code: string; message: string }> }
    >
  > =>
    Object.freeze({
      ok: false as const,
      error: Object.freeze({
        code: "OFFLINE_READ_ONLY",
        message: "当前为离线只读模式，不能执行写操作",
      }),
    }),
});

function readSystemDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function CounterShellCore(props: CounterShellCoreProps) {
  const scope = props.session.session;
  return (
    <ReceiveWorkspaceProvider
      scope={`${scope.org_id}:${scope.store_id}:${scope.session_id}:${scope.staff_id}:${scope.session_version}`}
      {...(props.receiveRecoveryPort === undefined ? {} : { recovery: props.receiveRecoveryPort })}
      session={props.session}
      query={props.queryClient}
    >
      <CounterShellContent {...props} />
    </ReceiveWorkspaceProvider>
  );
}

function CounterShellContent({
  PageHostComponent,
  session,
  authClient,
  onSessionChange,
  initialConnection,
  initialTheme,
  initialNav = "workbench",
  systemDark,
  documentRef = null,
  printSummary: printSummaryProp,
  initialLoadingMs = 0,
  commandClient,
  queryClient,
  photoPort,
  healthPort,
  offlinePort,
  printerPort,
  aiPort,
  aiSettingsPort,
  migrationPort,
  maintenancePort,
  storeExportPort,
  paymentChannelPort,
  miniappSettingsPort,
  remoteAssistancePort,
  scalePort,
  notificationSettingsPort,
  readOnly = false,
}: CounterShellCoreProps) {
  const [expanded, setExpanded] = useState(readSidebarExpanded);
  const [activeId, setActiveId] = useState<NavItemId>(initialNav);
  // ADR-91 P1-9: a toast belongs to the page that raised it.
  useToastPageScope(activeId);
  const [themePref, setThemePref] = useState<ThemePreference>(
    () => initialTheme ?? initialCounterTheme(browserThemeStorage()),
  );
  const [loading, setLoading] = useState(initialLoadingMs > 0);
  const [pinOpen, setPinOpen] = useState(false);
  const [printQueueOpen, setPrintQueueOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [intent, setIntent] = useState<NavigationIntent | undefined>(undefined);
  const intentNonce = useRef(0);

  const connection = useLiveConnection(
    session,
    initialConnection,
    healthPort,
    offlinePort,
    readOnly,
  );
  const { store: receiveStore, confirmDiscard } = useReceiveWorkspaceAccess();
  const openStaffSwitch = useCallback(() => {
    void (async () => {
      const current = receiveStore.getSnapshot();
      if (
        current.busy ||
        current.phase === "uncertain" ||
        !["browser", "ready"].includes(current.recoveryStatus)
      ) {
        setActiveId("receive");
        return;
      }
      if (
        hasReceiveWork(current) &&
        !(await confirmDiscard(
          current.recoveryStatus === "browser"
            ? "切换员工会清除本会话未暂存的开单内容。需要保留时，请先返回开单页暂存。"
            : "开单内容已加密保留在本机，切换后仅原员工重新登录可恢复。确认切换员工？",
        ))
      )
        return;
      setPinOpen(true);
    })();
  }, [receiveStore, confirmDiscard]);
  const dark = systemDark ?? readSystemDark();
  const printSummary = usePrintJobSummary(
    queryClient,
    readOnly ? Object.freeze({ queued: 0, failed: 0 }) : printSummaryProp,
  );
  const effectiveCommandClient = readOnly ? READ_ONLY_COMMAND_PORT : commandClient;
  const permission = useMemo(
    () => permissionContextFrom(session.role, session.features),
    [session.role, session.features],
  );
  const navItems = useMemo(() => filterNavItems(permission), [permission]);

  useEffect(() => {
    const doc = documentRef ?? (typeof document !== "undefined" ? document : null);
    if (!doc) return;
    applyThemeToDocument(doc, resolveTheme(themePref, dark));
  }, [themePref, dark, documentRef]);

  // Window / taskbar title follows the page (Electron mirrors document.title).
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = `${navLabel(activeId)} · ${session.display.store_name} · 洗衣柜台`;
  }, [activeId, session.display.store_name]);

  useEffect(() => {
    if (initialLoadingMs <= 0) return;
    const timer = setTimeout(() => setLoading(false), initialLoadingMs);
    return () => clearTimeout(timer);
  }, [initialLoadingMs]);

  const setTheme = useCallback((preference: ThemePreference) => {
    setThemePref(preference);
    writeStoredThemePreference(browserThemeStorage(), preference);
  }, []);
  const themeControl = useMemo(
    () => Object.freeze({ preference: themePref, setPreference: setTheme }),
    [setTheme, themePref],
  );

  const toggleSidebar = useCallback(() => {
    setExpanded((value) => {
      writeSidebarExpanded(!value);
      return !value;
    });
  }, []);

  const openIntent = useCallback((next: NavigationIntentInput, target: NavItemId) => {
    intentNonce.current += 1;
    setIntent(Object.freeze({ ...next, nonce: intentNonce.current }));
    setActiveId(target);
  }, []);

  const commands = useMemo(
    () =>
      shellCommands({
        navItems,
        readOnly,
        expanded,
        onNavigate: setActiveId,
        onSwitchStaff: openStaffSwitch,
        onOpenPrintQueue: () => setPrintQueueOpen(true),
        onSetTheme: setTheme,
        onShowShortcuts: () => setHelpOpen(true),
        onToggleSidebar: toggleSidebar,
      }),
    [expanded, navItems, readOnly, setTheme, toggleSidebar, openStaffSwitch],
  );
  const canOpen = useMemo(
    () =>
      Object.freeze({
        pickup: navItems.some((item) => item.id === "pickup") && !readOnly,
        customers: navItems.some((item) => item.id === "customers"),
      }),
    [navItems, readOnly],
  );
  const lookups = useCallback(
    (query: string) =>
      lookupCommands(
        query,
        {
          onPickupLookup: (key) => openIntent({ kind: "pickup-lookup", key }, "pickup"),
          onCustomerSearch: (text) =>
            openIntent({ kind: "customer-search", query: text }, "customers"),
        },
        canOpen,
      ),
    [canOpen, openIntent],
  );

  useShellShortcuts({
    onPalette: () => setPaletteOpen(true),
    onHelp: () => setHelpOpen(true),
    onNavDigit: (digit) => {
      const target = navTargetForDigit(navItems, digit);
      if (target !== null) setActiveId(target);
    },
  });

  return (
    <ThemeControlContext.Provider value={themeControl}>
      <div
        className="ld-shell"
        data-shell="counter"
        data-nav={activeId}
        data-role={session.role}
        data-read-only={readOnly ? "true" : "false"}
      >
        <a className="ld-skip-link" href="#main-content">
          跳到主内容
        </a>
        <Sidebar
          expanded={expanded}
          activeId={activeId}
          onSelect={setActiveId}
          onToggleExpand={toggleSidebar}
          items={navItems}
        />
        <div className="ld-shell-body">
          <TopBar
            connection={connection}
            printSummary={printSummary}
            onOpenPrintQueue={() => setPrintQueueOpen(true)}
            onOpenCommand={() => setPaletteOpen(true)}
            {...(readOnly || aiPort === undefined
              ? {}
              : { aiOpen, onToggleAi: () => setAiOpen((value) => !value) })}
            {...(readOnly ? {} : { onSwitchStaff: openStaffSwitch })}
            readOnly={readOnly}
          />
          {readOnly ? (
            <div className="ld-offline-read-only" role="status">
              离线只读：当前显示本机加密缓存，不能开单、收款、取衣或修改资料。
            </div>
          ) : null}
          <RouteGate permission={permission} activeId={activeId} onNavigate={setActiveId}>
            <PageHostComponent
              {...(paymentChannelPort === undefined ? {} : { paymentChannelPort })}
              {...(miniappSettingsPort === undefined ? {} : { miniappSettingsPort })}
              {...(remoteAssistancePort === undefined ? {} : { remoteAssistancePort })}
              {...(migrationPort === undefined ? {} : { migrationPort })}
              {...(maintenancePort === undefined ? {} : { maintenancePort })}
              {...(scalePort === undefined ? {} : { scalePort })}
              {...(storeExportPort === undefined ? {} : { storeExportPort })}
              {...(notificationSettingsPort === undefined ? {} : { notificationSettingsPort })}
              {...(aiSettingsPort === undefined ? {} : { aiSettingsPort })}
              activeId={activeId}
              loading={loading}
              onNavigate={setActiveId}
              session={session}
              authClient={authClient}
              commandClient={effectiveCommandClient}
              queryClient={queryClient}
              onSessionChange={onSessionChange}
              {...(intent === undefined ? {} : { intent })}
              {...(offlinePort === undefined ? {} : { offlinePort })}
              {...(printerPort === undefined || readOnly ? {} : { printerPort })}
              {...(photoPort === undefined || readOnly ? {} : { photoPort })}
            />
          </RouteGate>
        </div>
        <PinSwitchDialog
          key={`${session.session.staff_id}:${session.session.session_version}`}
          open={pinOpen}
          onClose={() => setPinOpen(false)}
          authClient={authClient}
          currentStaffId={session.session.staff_id}
          onSwitched={(next) => {
            onSessionChange(next);
            setPinOpen(false);
          }}
        />
        <PrintQueuePanel
          open={printQueueOpen}
          onClose={() => setPrintQueueOpen(false)}
          queryClient={queryClient}
          commandClient={effectiveCommandClient}
        />
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          commands={commands}
          lookups={lookups}
        />
        <ShortcutHelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
        {aiPort === undefined ? null : (
          <AiPanel
            open={aiOpen}
            onClose={() => setAiOpen(false)}
            authSessionId={session.session.session_id}
            aiPort={aiPort}
          />
        )}
      </div>
    </ThemeControlContext.Provider>
  );
}
