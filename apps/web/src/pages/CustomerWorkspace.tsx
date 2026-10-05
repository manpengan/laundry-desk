/** Right-hand customer workspace: profile, history, delivery, member and governance panels. */

import { Button, type useToast } from "@laundry/ui";
import { useState } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import type { PrintJobView } from "../shell/print-jobs.js";
import { CustomerDetail } from "./CustomerDetail.js";
import { CustomerGovernancePanel } from "./CustomerGovernancePanel.js";
import type { CustomerRowView } from "./customer-model.js";
import { CustomerPrivacyPanel } from "./CustomerPrivacyPanel.js";
import { CustomerProfilePanel } from "./CustomerProfilePanel.js";
import { DeliveryAppointmentPanel } from "./DeliveryAppointmentPanel.js";
import { MemberBalancePanel } from "./MemberBalancePanel.js";
import { MemberBenefitsPanel } from "./MemberBenefitsPanel.js";
import type { OrderListRowView } from "./OrdersList.js";

export type CustomerWorkspaceProps = Readonly<{
  customer: CustomerRowView;
  orders: readonly OrderListRowView[];
  printJobs: readonly PrintJobView[] | null;
  ordersBusy: boolean;
  ordersPage?: Readonly<{ total: number; offset: number; limit: number }>;
  ordersError?: string | null;
  onOrdersPage?: (offset: number) => void;
  onOrdersRetry?: () => void;
  queryClient: QueryPort;
  commandClient: CommandPort;
  authClient?: AuthClient;
  session?: SessionView;
  toast: ReturnType<typeof useToast>;
  onClose: () => void;
  onOpenOrder: (orderId: string) => void;
  onOpenPickup?: (orderId: string) => void;
  onReselect: () => void;
  onRemoved: () => void;
}>;

export function CustomerWorkspace({
  customer,
  orders,
  printJobs,
  ordersBusy,
  ordersPage,
  ordersError,
  onOrdersPage,
  onOrdersRetry,
  queryClient,
  commandClient,
  authClient,
  session,
  toast,
  onClose,
  onOpenOrder,
  onOpenPickup,
  onReselect,
  onRemoved,
}: CustomerWorkspaceProps) {
  const auth = authClient === undefined ? {} : { authClient };
  const withSession = session === undefined ? {} : { session };
  const [section, setSection] = useState("orders");
  const sections = [
    { id: "orders", label: "历史订单" },
    { id: "profile", label: "客户档案与预约" },
    ...(session?.features.member_enabled ? [{ id: "member", label: "会员充值与权益" }] : []),
    { id: "risk", label: "合并与隐私处理" },
  ];
  return (
    <div className="ld-customer-task-workspace">
      <header className="ld-customer-workspace-identity">
        <strong>当前客户：{customer.name ?? "未命名客户"}</strong>
        <span className="ld-customers-phone-internal">{customer.phone}</span>
        <Button type="button" variant="ghost" onClick={onClose} data-testid="customer-detail-close">
          关闭客户工作区
        </Button>
      </header>
      <nav className="ld-customer-workspace-nav" aria-label="客户工作区分区">
        {sections.map((item) => (
          <Button
            key={item.id}
            type="button"
            variant={section === item.id ? "primary" : "secondary"}
            aria-pressed={section === item.id}
            aria-controls={`customer-section-${item.id}`}
            onClick={() => setSection(item.id)}
          >
            {item.label}
          </Button>
        ))}
      </nav>
      {session?.features.member_enabled === true ? (
        <div className="ld-customer-member-summary" id="customer-section-member">
          <MemberBalancePanel
            customer={customer}
            queryClient={queryClient}
            commandClient={commandClient}
            {...auth}
            session={session}
            toast={toast}
            summaryOnly={section !== "member"}
          />
          <MemberBenefitsPanel
            customer={customer}
            queryClient={queryClient}
            commandClient={commandClient}
            session={session}
            toast={toast}
            summaryOnly={section !== "member"}
          />
        </div>
      ) : null}
      <div id="customer-section-orders" hidden={section !== "orders"}>
        <CustomerDetail
          customer={customer}
          orders={orders}
          printJobs={printJobs}
          busy={ordersBusy}
          onClose={onClose}
          showClose={false}
          onOpenOrder={onOpenOrder}
          {...(ordersPage === undefined ? {} : { ordersPage })}
          {...(ordersError === undefined ? {} : { ordersError })}
          {...(onOrdersPage === undefined ? {} : { onOrdersPage })}
          {...(onOrdersRetry === undefined ? {} : { onOrdersRetry })}
          {...(onOpenPickup === undefined ? {} : { onOpenPickup })}
        />
      </div>
      <div id="customer-section-profile" hidden={section !== "profile"}>
        <CustomerGovernancePanel
          mode="profile"
          customer={customer}
          queryClient={queryClient}
          commandClient={commandClient}
          {...auth}
          {...withSession}
          onUpdated={onReselect}
          onMerged={onRemoved}
        />
        <CustomerProfilePanel
          customer={customer}
          queryClient={queryClient}
          commandClient={commandClient}
          {...auth}
          {...withSession}
        />
        {session !== undefined ? (
          <DeliveryAppointmentPanel
            key={customer.customer_id}
            customer={customer}
            queryClient={queryClient}
            commandClient={commandClient}
            featureEnabled={session.features.delivery_enabled === true}
            {...auth}
            session={session}
          />
        ) : null}
      </div>
      <div id="customer-section-risk" hidden={section !== "risk"}>
        <p className="ld-form-error">
          正在处理：{customer.name ?? "未命名客户"} · {customer.phone}
          。合并与隐私操作会影响此客户，请核对目标。
        </p>
        <CustomerGovernancePanel
          mode="merge"
          customer={customer}
          queryClient={queryClient}
          commandClient={commandClient}
          {...auth}
          {...withSession}
          onUpdated={onReselect}
          onMerged={onRemoved}
        />
        <CustomerPrivacyPanel
          customer={customer}
          queryClient={queryClient}
          commandClient={commandClient}
          {...auth}
          {...withSession}
          onAnonymized={onRemoved}
        />
      </div>
    </div>
  );
}
