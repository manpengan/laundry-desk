import { z } from "zod";

import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_STORE_ID } from "./demo-ids.js";

export type LocalProfile = Readonly<{
  orgId: string;
  storeId: string;
  adminStaffId: string;
  orgCode: "local";
  storeCode: "main";
  orgName: "laundry-desk V2";
  storeName: "本地门店";
  timezone: string;
}>;

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

const LocalProfileSchema: z.ZodType<LocalProfile> = z
  .object({
    orgId: z.uuid(),
    storeId: z.uuid(),
    adminStaffId: z.uuid(),
    orgCode: z.literal("local"),
    storeCode: z.literal("main"),
    orgName: z.literal("laundry-desk V2"),
    storeName: z.literal("本地门店"),
    timezone: z.string().refine(isIanaTimezone, "timezone must be a valid IANA name"),
  })
  .readonly();

export const LOCAL_PROFILE: LocalProfile = Object.freeze(
  LocalProfileSchema.parse({
    orgId: DEMO_ORG_ID,
    storeId: DEMO_STORE_ID,
    adminStaffId: DEMO_ADMIN_ID,
    orgCode: "local",
    storeCode: "main",
    orgName: "laundry-desk V2",
    storeName: "本地门店",
    timezone: "Asia/Taipei",
  }),
);
