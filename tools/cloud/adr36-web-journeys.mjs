export {
  authJourney,
  baselineJourney,
  cashOrderJourney,
  catalogJourney,
  customerJourney,
  syntheticRun,
} from "./adr36-web-counter-journeys.mjs";
export {
  accountingDeltaJourney,
  cleanupArtifacts,
  initialArtifacts,
  logoutSessions,
} from "./adr36-web-journey-lifecycle.mjs";
export { memberJourney } from "./adr36-web-member-journey.mjs";

export const MAIN_JOURNEYS = Object.freeze([
  "dual_admin_auth",
  "accounting_baseline",
  "catalog_price",
  "synthetic_customer",
  "cash_order_fulfillment",
  "member_lifecycle",
  "accounting_today_delta",
]);
