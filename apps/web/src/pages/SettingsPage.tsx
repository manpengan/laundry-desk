/** Store administration plus device-local desktop capabilities. */

import { cn, Icon, type IconName } from "@laundry/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import type { OfflinePort } from "../host/offline-port.js";
import type { PrinterPort } from "../host/printer-port.js";
import type { AiSettingsPort } from "../ai/settings-port.js";
import { AiSettingsPanel } from "../ai/AiSettingsPanel.js";
import type { StoreExportPort } from "../host/store-export-port.js";
import type { PaymentChannelPort } from "../host/payment-channel-port.js";
import type { MiniappSettingsPort } from "../host/miniapp-settings-port.js";
import type { RemoteAssistancePort } from "../host/remote-assistance-port.js";
import { PaymentChannelPanel } from "./PaymentChannelPanel.js";
import { MiniappSettingsPanel } from "./MiniappSettingsPanel.js";
import { MiniappNotificationPanel } from "./MiniappNotificationPanel.js";
import { RemoteAssistancePanel } from "./RemoteAssistancePanel.js";
import type { MigrationPort } from "../host/migration-port.js";
import type { NotificationSettingsPort } from "../host/notification-settings-port.js";
import { NotificationSettingsPanel } from "./NotificationSettingsPanel.js";
import { StoreExportPanel } from "./StoreExportPanel.js";
import { V1MigrationPanel } from "./V1MigrationPanel.js";
import { AppearanceSettingsPanel } from "./AppearanceSettingsPanel.js";
import { CatalogMaintenancePanel } from "./CatalogMaintenancePanel.js";
import { CatalogAuditPanel } from "./CatalogAuditPanel.js";
import { DeliveryPolicyPanel } from "./DeliveryPolicyPanel.js";
import { MemberBonusRulesPanel } from "./MemberBonusRulesPanel.js";
import { MemberBenefitDefinitionsPanel } from "./MemberBenefitDefinitionsPanel.js";
import { OfflineConflictPanel } from "./OfflineConflictPanel.js";
import { PricingSettingsPanel } from "./PricingSettingsPanel.js";
import { PrinterSettingsPanel } from "./PrinterSettingsPanel.js";
import { PrinterSupportPanel } from "./PrinterSupportPanel.js";
import { StaffAccessPanel } from "./StaffAccessPanel.js";

export { PRINTER_PATH_ENV_NAME } from "./PrinterSupportPanel.js";

export type SettingsPageProps = {
  session: SessionView;
  authClient: AuthClient;
  commandClient: CommandPort;
  queryClient?: QueryPort;
  offlinePort?: OfflinePort;
  printerPort?: PrinterPort;
  aiSettingsPort?: AiSettingsPort;
  migrationPort?: MigrationPort;
  storeExportPort?: StoreExportPort;
  paymentChannelPort?: PaymentChannelPort;
  miniappSettingsPort?: MiniappSettingsPort;
  remoteAssistancePort?: RemoteAssistancePort;
  notificationSettingsPort?: NotificationSettingsPort;
  /**
   * ADR-91 D-1/D-2: the customer mini program, WeChat subscription reminders and remote
   * assistance need a filed public HTTPS entry, which ADR-71 has paused. Their panels stay
   * in the code but no host offers them until an ADR restores that entry.
   */
  publicEntryFeatures?: boolean;
  onSessionChange?: (session: SessionView | null) => void;
};

type SettingsSection = Readonly<{
  id: string;
  label: string;
  icon: IconName;
  content: ReactNode;
}>;

function scrollBehavior(): ScrollBehavior {
  const reduce =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return reduce ? "auto" : "smooth";
}

/** Scroll-spy: highlight the section nearest the top of the viewport. */
function useActiveSection(ids: readonly string[]): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  const key = ids.join("|");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
        const first = visible[0]?.target.id;
        if (first !== undefined) setActive(first);
      },
      { rootMargin: "-20% 0px -65% 0px" },
    );
    for (const id of key.split("|")) {
      const element = document.getElementById(id);
      if (element !== null) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [key]);
  return active;
}

export function SettingsPage({
  session,
  authClient,
  commandClient,
  queryClient,
  offlinePort,
  printerPort,
  aiSettingsPort,
  migrationPort,
  storeExportPort,
  paymentChannelPort,
  miniappSettingsPort,
  remoteAssistancePort,
  notificationSettingsPort,
  publicEntryFeatures = false,
  onSessionChange,
}: SettingsPageProps) {
  const sections: SettingsSection[] = [
    {
      id: "settings-appearance",
      label: "外观与快捷键",
      icon: "sun",
      content: <AppearanceSettingsPanel />,
    },
  ];
  if (session.role === "admin" && paymentChannelPort !== undefined)
    sections.push({
      id: "settings-payments",
      label: "支付渠道与对账",
      icon: "settings",
      content: (
        <PaymentChannelPanel
          key={session.session.session_id + ":" + session.session.session_version}
          port={paymentChannelPort}
          authClient={authClient}
          commandClient={commandClient}
          session={session}
        />
      ),
    });
  const publicEntry = publicEntryFeatures && session.role === "admin";
  if (publicEntry && miniappSettingsPort !== undefined)
    sections.push({
      id: "settings-miniapp",
      label: "顾客微信小程序",
      icon: "settings",
      content: (
        <MiniappSettingsPanel
          port={miniappSettingsPort}
          sessionKey={session.session.session_id + ":" + session.session.session_version}
        />
      ),
    });
  if (publicEntry && remoteAssistancePort !== undefined)
    sections.push({
      id: "settings-remote-assistance",
      label: "远程协助",
      icon: "settings",
      content: (
        <RemoteAssistancePanel
          port={remoteAssistancePort}
          sessionKey={`${session.session.session_id}:${session.session.session_version}`}
        />
      ),
    });
  if (publicEntry && queryClient !== undefined)
    sections.push({
      id: "settings-miniapp-notifications",
      label: "微信订阅提醒",
      icon: "settings",
      content: (
        <MiniappNotificationPanel
          commandClient={commandClient}
          queryClient={queryClient}
          sessionKey={`${session.session.session_id}:${session.session.session_version}`}
        />
      ),
    });
  if (session.role === "admin" && storeExportPort !== undefined)
    sections.push({
      id: "settings-store-export",
      label: "整店业务导出",
      icon: "settings",
      content: (
        <StoreExportPanel
          port={storeExportPort}
          sessionKey={session.session.session_id + ":" + session.session.session_version}
        />
      ),
    });
  if (session.role === "admin" && migrationPort !== undefined)
    sections.push({
      id: "settings-migration",
      label: "旧版数据导入",
      icon: "settings",
      content: (
        <V1MigrationPanel
          port={migrationPort}
          sessionKey={`${session.session.session_id}:${session.session.session_version}`}
        />
      ),
    });
  if (session.role === "admin" && notificationSettingsPort !== undefined)
    sections.push({
      id: "settings-notification",
      label: "阿里云短信",
      icon: "settings",
      content: (
        <NotificationSettingsPanel
          port={notificationSettingsPort}
          sessionKey={`${session.session.session_id}:${session.session.session_version}`}
        />
      ),
    });
  if (session.role === "admin" && aiSettingsPort !== undefined)
    sections.push({
      id: "settings-ai",
      label: "AI 助手与密钥",
      icon: "settings",
      content: (
        <AiSettingsPanel
          key={session.session.session_id}
          port={aiSettingsPort}
          authClient={authClient}
          staffId={session.session.staff_id}
        />
      ),
    });
  if (queryClient !== undefined) {
    sections.push(
      {
        id: "settings-pricing",
        label: "计价设置",
        icon: "receive",
        content: (
          <PricingSettingsPanel
            session={session}
            authClient={authClient}
            commandClient={commandClient}
            queryClient={queryClient}
          />
        ),
      },
      {
        id: "settings-delivery",
        label: "取送策略",
        icon: "delivery",
        content: (
          <DeliveryPolicyPanel
            session={session}
            authClient={authClient}
            commandClient={commandClient}
            queryClient={queryClient}
          />
        ),
      },
    );
  }
  sections.push({
    id: "settings-catalog",
    label: "价目维护",
    icon: "shirt",
    content: (
      <>
        <CatalogMaintenancePanel
          commandClient={commandClient}
          {...(queryClient !== undefined ? { queryClient } : {})}
        />
        {queryClient === undefined ? null : <CatalogAuditPanel queryClient={queryClient} />}
      </>
    ),
  });
  if (queryClient !== undefined && session.features.member_enabled === true) {
    sections.push({
      id: "settings-member",
      label: "会员权益",
      icon: "customers",
      content: (
        <>
          <MemberBonusRulesPanel commandClient={commandClient} queryClient={queryClient} />
          {session.role === "admin" ? (
            <MemberBenefitDefinitionsPanel
              commandClient={commandClient}
              queryClient={queryClient}
            />
          ) : null}
        </>
      ),
    });
  }
  sections.push({
    id: "settings-staff",
    label: "员工与权限",
    icon: "switchUser",
    content: (
      <StaffAccessPanel
        currentStaffId={session.session.staff_id}
        authClient={authClient}
        commandClient={commandClient}
        {...(queryClient !== undefined ? { queryClient } : {})}
        {...(onSessionChange !== undefined ? { onSessionChange } : {})}
      />
    ),
  });
  if (offlinePort !== undefined) {
    sections.push({
      id: "settings-offline",
      label: "离线同步",
      icon: "refresh",
      content: <OfflineConflictPanel offlinePort={offlinePort} />,
    });
  }
  if (printerPort !== undefined && session.role === "admin") {
    sections.push({
      id: "settings-printer",
      label: "小票打印机",
      icon: "printer",
      content: <PrinterSettingsPanel printerPort={printerPort} />,
    });
  }
  sections.push({
    id: "settings-support",
    label: "技术支持",
    icon: "keyboard",
    content: <PrinterSupportPanel />,
  });

  const active = useActiveSection(sections.map((section) => section.id));
  const contentRef = useRef<HTMLDivElement | null>(null);

  return (
    <main className="ld-shell-main ld-settings" id="main-content" tabIndex={-1}>
      <h1 className="ld-shell-main__title">设置</h1>
      <p className="ld-shell-main__hint">
        计价、价目、员工等高风险修改需另一位店长现场复核，所有修改都会留下审计记录。
      </p>
      <div className="ld-settings-layout">
        <nav className="ld-settings-nav" aria-label="设置分区">
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              className={cn("ld-settings-nav__item", active === section.id && "is-active")}
              aria-current={active === section.id ? "true" : undefined}
              onClick={() =>
                contentRef.current
                  ?.querySelector(`#${section.id}`)
                  ?.scrollIntoView({ behavior: scrollBehavior(), block: "start" })
              }
            >
              <Icon name={section.icon} size={18} />
              {section.label}
            </button>
          ))}
        </nav>
        <div ref={contentRef} className="ld-settings-content">
          {sections.map((section) => (
            <div key={section.id} id={section.id} className="ld-settings-anchor">
              {section.content}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
