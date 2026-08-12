import { createCommandError } from "@laundry/contracts";

import type { BusContext, HandlerContext } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import type { BusinessDayLockPort } from "../workday/business-day-lock.js";
import { assertBusinessDayOpen, deriveBusinessDate } from "../order/server-pricing.js";
import type { FulfillmentStore } from "./types.js";
import { z } from "zod";

const DeviceIdSchema = z.uuid();

export type FulfillmentRuntimeDeps = Readonly<{
  store: FulfillmentStore;
  now?: () => number;
  timeZone?: string;
  rolloverHour?: number;
  isBusinessDayClosed?: (businessDate: string) => Promise<boolean>;
  lockBusinessDay?: BusinessDayLockPort;
  featureEnabled?: (client: SqlClient, tenant: TenantContext) => Promise<boolean>;
}>;

type FulfillmentContext = Pick<HandlerContext, "client" | "tenant"> | BusContext;

export async function assertFulfillmentEnabled(
  deps: FulfillmentRuntimeDeps,
  context: FulfillmentContext,
): Promise<void> {
  if (
    deps.featureEnabled === undefined ||
    !(await deps.featureEnabled(
      "client" in context ? context.client : context.transactionClient!,
      context.tenant,
    ))
  ) {
    throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
  }
}

export async function prepareFulfillmentWrite(
  deps: FulfillmentRuntimeDeps,
  context: FulfillmentContext,
): Promise<number> {
  const client = "client" in context ? context.client : context.transactionClient;
  if (client === undefined) {
    throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
  }
  const at = deps.now?.() ?? Math.floor(Date.now() / 1_000);
  const businessDate = deriveBusinessDate(at, deps.timeZone, deps.rolloverHour);
  await deps.lockBusinessDay?.(client, context.tenant, businessDate);
  await assertBusinessDayOpen(deps.isBusinessDayClosed, businessDate);
  await assertFulfillmentEnabled(deps, context);
  return at;
}

export function requireDeviceId(value: string | null): string {
  const parsed = DeviceIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
  }
  return parsed.data;
}
