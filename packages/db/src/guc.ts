/**
 * Transaction-local GUC names used for RLS (ADR-02 / A3).
 * Server C2 injects these via SET LOCAL after authentication.
 */
export const APP_ORG_ID_GUC = "app.org_id" as const;
export const APP_STORE_ID_GUC = "app.store_id" as const;
export const APP_STAFF_ID_GUC = "app.staff_id" as const;

export const APP_GUC_NAMES = Object.freeze({
  orgId: APP_ORG_ID_GUC,
  storeId: APP_STORE_ID_GUC,
  staffId: APP_STAFF_ID_GUC,
} as const);

export type AppGucName = typeof APP_ORG_ID_GUC | typeof APP_STORE_ID_GUC | typeof APP_STAFF_ID_GUC;
