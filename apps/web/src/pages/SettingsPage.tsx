/** Store administration plus device-local desktop capabilities. */

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import type { OfflinePort } from "../host/offline-port.js";
import type { PrinterPort } from "../host/printer-port.js";
import { CatalogMaintenancePanel } from "./CatalogMaintenancePanel.js";
import { CatalogAuditPanel } from "./CatalogAuditPanel.js";
import { DeliveryPolicyPanel } from "./DeliveryPolicyPanel.js";
import { MemberBonusRulesPanel } from "./MemberBonusRulesPanel.js";
import { MemberBenefitDefinitionsPanel } from "./MemberBenefitDefinitionsPanel.js";
import { OfflineConflictPanel } from "./OfflineConflictPanel.js";
import { PricingSettingsPanel } from "./PricingSettingsPanel.js";
import { PrinterSettingsPanel } from "./PrinterSettingsPanel.js";
import { StaffAccessPanel } from "./StaffAccessPanel.js";

export type SettingsPageProps = {
  session: SessionView;
  authClient: AuthClient;
  commandClient: CommandPort;
  queryClient?: QueryPort;
  offlinePort?: OfflinePort;
  printerPort?: PrinterPort;
  onSessionChange?: (session: SessionView | null) => void;
};

/** Env var operators set for CLI / Edge USB path (documented name). */
export const PRINTER_PATH_ENV_NAME = "LAUNDRY_PRINTER_PATH";

export function SettingsPage({
  session,
  authClient,
  commandClient,
  queryClient,
  offlinePort,
  printerPort,
  onSessionChange,
}: SettingsPageProps) {
  return (
    <main className="ld-shell-main lg-card" id="main-content" tabIndex={-1}>
      <h1 className="ld-shell-main__title">设置</h1>
      <p className="ld-shell-main__hint">
        门店价目与计价策略由服务端保存并审计；高风险修改不可自核，也不会切换当前员工。
      </p>

      {queryClient === undefined ? null : (
        <PricingSettingsPanel
          session={session}
          authClient={authClient}
          commandClient={commandClient}
          queryClient={queryClient}
        />
      )}

      {queryClient === undefined ? null : (
        <DeliveryPolicyPanel
          session={session}
          authClient={authClient}
          commandClient={commandClient}
          queryClient={queryClient}
        />
      )}

      <CatalogMaintenancePanel
        commandClient={commandClient}
        {...(queryClient !== undefined ? { queryClient } : {})}
      />

      {queryClient === undefined ? null : <CatalogAuditPanel queryClient={queryClient} />}

      {queryClient === undefined || session.features.member_enabled !== true ? null : (
        <MemberBonusRulesPanel commandClient={commandClient} queryClient={queryClient} />
      )}

      {queryClient === undefined ||
      session.features.member_enabled !== true ||
      session.role !== "admin" ? null : (
        <MemberBenefitDefinitionsPanel commandClient={commandClient} queryClient={queryClient} />
      )}

      <StaffAccessPanel
        currentStaffId={session.session.staff_id}
        authClient={authClient}
        commandClient={commandClient}
        {...(queryClient !== undefined ? { queryClient } : {})}
        {...(onSessionChange !== undefined ? { onSessionChange } : {})}
      />

      {offlinePort === undefined ? null : <OfflineConflictPanel offlinePort={offlinePort} />}

      {printerPort === undefined || session.role !== "admin" ? null : (
        <PrinterSettingsPanel printerPort={printerPort} />
      )}

      <section
        className="ld-settings-printer-smoke"
        data-testid="printer-smoke-section"
        aria-label="旧版打印机路径诊断"
      >
        <h2 className="ld-settings-printer-smoke__title">旧版 USB / Windows CLI 诊断</h2>
        <p className="ld-settings-printer-smoke__hint">
          此入口不属于 macOS CUPS 签名打印；仅验证 Edge 打印机 path（env{" "}
          <code className="ld-settings-printer-smoke__code">{PRINTER_PATH_ENV_NAME}</code>
          ）。Windows 接受 <code className="ld-settings-printer-smoke__code">\\.\COM3</code>、
          <code className="ld-settings-printer-smoke__code">\\.\LPT1</code>、
          <code className="ld-settings-printer-smoke__code">\\.\USB001</code>；POSIX 仅接受
          <code className="ld-settings-printer-smoke__code"> /dev</code> 下真实字符设备。
        </p>
        <div className="ld-settings-printer-smoke__static" data-testid="printer-smoke-static">
          <p className="ld-settings-printer-smoke__static-lead">
            renderer 不提供任意设备 path 或 raw bytes smoke IPC。请在装机机 PowerShell /
            终端先验证配置，再显式执行物理冒烟：
          </p>
          <pre className="ld-settings-printer-smoke__cmd" data-testid="printer-smoke-cli-hint">
            {`$env:${PRINTER_PATH_ENV_NAME} = '\\\\.\\COM3'\npnpm --filter @laundry/edge-agent printer-smoke -- --validate\npnpm --filter @laundry/edge-agent printer-smoke`}
          </pre>
          <p className="ld-settings-printer-smoke__static-foot">
            详见{" "}
            <code className="ld-settings-printer-smoke__code">
              apps/edge-agent/docs/printer-smoke-windows.md
            </code>
            。
          </p>
        </div>
      </section>
    </main>
  );
}
