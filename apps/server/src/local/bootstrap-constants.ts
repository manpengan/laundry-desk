import { DEMO_STAFF_B_ID } from "./demo-ids.js";

// Stable transaction lock and row identifiers make local commissioning repeatable
// across Runtime releases without accepting caller-selected owner identifiers.
export const LOCAL_BOOTSTRAP_ADVISORY_LOCK_ID = "-5847291036815640321";
export const BOOTSTRAP_ADMIN_ROLE_ID = "55555555-5555-4555-8555-111111111103";
export const BOOTSTRAP_APPROVER_STAFF_ID = DEMO_STAFF_B_ID;
export const BOOTSTRAP_APPROVER_ROLE_ID = "55555555-5555-4555-8555-111111111102";
export const BOOTSTRAP_FEATURE_ROW_ID = "88888888-8888-4888-8888-888888888881";
export const BOOTSTRAP_COMMISSION_AUDIT_ID = "77777777-7777-4777-8777-777777777831";
export const LOCAL_FEATURE_PROFILE_VERSION = 1;

export const LOCAL_FEATURE_PROFILE = Object.freeze({
  fulfillment: true,
  membership: true,
  shiftClosing: true,
  delivery: false,
  marketing: false,
  ai: false,
});
