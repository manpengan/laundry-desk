/** Right-hand customer workspace: profile, history, delivery, member and governance panels. */

import type { useToast } from "@laundry/ui";

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
  return (
    <>
      <CustomerDetail
        customer={customer}
        orders={orders}
        printJobs={printJobs}
        busy={ordersBusy}
        onClose={onClose}
        onOpenOrder={onOpenOrder}
        {...(onOpenPickup === undefined ? {} : { onOpenPickup })}
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
      {session?.features.member_enabled === true ? (
        <>
          <MemberBalancePanel
            customer={customer}
            queryClient={queryClient}
            commandClient={commandClient}
            {...auth}
            session={session}
            toast={toast}
          />
          <MemberBenefitsPanel
            customer={customer}
            queryClient={queryClient}
            commandClient={commandClient}
            session={session}
            toast={toast}
          />
        </>
      ) : null}
      <CustomerGovernancePanel
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
    </>
  );
}
