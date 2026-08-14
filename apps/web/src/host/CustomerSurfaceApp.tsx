import { CustomerPortalApp } from "../customer-portal/CustomerPortalApp.js";
import { createHttpCustomerPortalClient } from "../customer-portal/client.js";

export type CustomerSurfaceAppProps = Readonly<{ apiBaseUrl: string }>;

export function CustomerSurfaceApp({ apiBaseUrl }: CustomerSurfaceAppProps) {
  return <CustomerPortalApp client={createHttpCustomerPortalClient({ apiBaseUrl })} />;
}
