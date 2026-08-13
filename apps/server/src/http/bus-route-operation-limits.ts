import type { FastifyReply } from "fastify";

import {
  DELIVERY_APPOINTMENT_COMMAND_NAMES,
  DELIVERY_APPOINTMENT_QUERY_NAMES,
  DELIVERY_EVIDENCE_COMMAND_NAMES,
  DELIVERY_EVIDENCE_QUERY_NAMES,
  DELIVERY_ORDER_COMMAND_NAMES,
  DELIVERY_ORDER_QUERY_NAMES,
  DELIVERY_POLICY_COMMAND_NAMES,
  DELIVERY_POLICY_QUERY_NAMES,
  DELIVERY_TASK_COMMAND_NAMES,
  DELIVERY_TASK_QUERY_NAMES,
  MARKETING_COMMAND_NAMES,
  MARKETING_COUPON_COMMAND_NAMES,
  MARKETING_COUPON_QUERY_NAMES,
  MARKETING_EXTENSION_COMMAND_NAMES,
  MARKETING_QUERY_NAMES,
} from "@laundry/contracts";

import type { AuthorizedSession } from "../auth/session-view.js";
import { fail } from "./auth-route-support.js";
import type { MarketingOperationRateLimiter } from "./marketing-operation-rate-limit.js";

export const DELIVERY_COMMANDS: ReadonlySet<string> = new Set([
  ...DELIVERY_POLICY_COMMAND_NAMES,
  ...DELIVERY_APPOINTMENT_COMMAND_NAMES,
  ...DELIVERY_ORDER_COMMAND_NAMES,
  ...DELIVERY_TASK_COMMAND_NAMES,
  ...DELIVERY_EVIDENCE_COMMAND_NAMES,
]);

export const DELIVERY_QUERIES: ReadonlySet<string> = new Set([
  ...DELIVERY_POLICY_QUERY_NAMES,
  ...DELIVERY_APPOINTMENT_QUERY_NAMES,
  ...DELIVERY_ORDER_QUERY_NAMES,
  ...DELIVERY_TASK_QUERY_NAMES,
  ...DELIVERY_EVIDENCE_QUERY_NAMES,
]);

export const MARKETING_COMMANDS: ReadonlySet<string> = new Set([
  ...MARKETING_COMMAND_NAMES,
  ...MARKETING_COUPON_COMMAND_NAMES,
  ...MARKETING_EXTENSION_COMMAND_NAMES,
]);

export const MARKETING_QUERIES: ReadonlySet<string> = new Set([
  ...MARKETING_QUERY_NAMES,
  ...MARKETING_COUPON_QUERY_NAMES,
]);

export function enforceMarketingOperationLimit(
  limiter: MarketingOperationRateLimiter,
  kind: "command" | "query",
  resolved: AuthorizedSession,
  reply: FastifyReply,
) {
  const decision = limiter.check(
    kind,
    resolved.session.session_id,
    resolved.session.org_id,
    resolved.session.store_id,
  );
  if (decision.allowed) return null;
  reply.header("Retry-After", String(decision.retryAfterSeconds));
  reply.code(429);
  return fail("RATE_LIMITED");
}
