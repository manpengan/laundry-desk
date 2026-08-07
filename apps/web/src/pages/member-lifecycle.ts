import type { CommandPort, CommandResult } from "../commands/types.js";
import type {
  MemberAccountStatusView,
  MemberAccountSummary,
  MemberTenderView,
} from "./member-model.js";

export const MEMBER_LIFECYCLE_COMMANDS = Object.freeze({
  freeze: "member.account.freeze",
  unfreeze: "member.account.unfreeze",
  close: "member.account.close",
} as const);

export type MemberLifecycleAction = keyof typeof MEMBER_LIFECYCLE_COMMANDS;
export type MemberLifecycleCommand = (typeof MEMBER_LIFECYCLE_COMMANDS)[MemberLifecycleAction];

type MemberLifecycleCommonBody = Readonly<{
  account_id: string;
  expected_customer_id: string;
  expected_status_version: number;
  reason: string;
}>;

export type MemberFreezeBody = MemberLifecycleCommonBody;
export type MemberUnfreezeBody = MemberLifecycleCommonBody;
export type MemberCloseBody = MemberLifecycleCommonBody &
  Readonly<{
    expected_status: Exclude<MemberAccountStatusView, "closed">;
    expected_principal_cents: number;
    expected_bonus_cents: number;
    refund_tender: MemberTenderView | null;
  }>;

export type MemberLifecycleBody = MemberFreezeBody | MemberUnfreezeBody | MemberCloseBody;

export type MemberLifecyclePending = Readonly<{
  action: MemberLifecycleAction;
  command: MemberLifecycleCommand;
  body: MemberLifecycleBody;
  confirmRef: string;
  gate: "confirm" | "step_up";
}>;

export function normalizeMemberLifecycleReason(reason: string): string | null {
  const trimmed = reason.trim();
  return trimmed.length >= 1 && trimmed.length <= 256 ? trimmed : null;
}

export function buildMemberLifecycleBody(
  action: MemberLifecycleAction,
  account: MemberAccountSummary,
  reason: string,
  refundTender: MemberTenderView,
): MemberLifecycleBody | null {
  const normalizedReason = normalizeMemberLifecycleReason(reason);
  if (normalizedReason === null || account.status === "closed") return null;
  if (action === "freeze" && account.status !== "active") return null;
  if (action === "unfreeze" && account.status !== "frozen") return null;

  const common = Object.freeze({
    account_id: account.account_id,
    expected_customer_id: account.customer_id,
    expected_status_version: account.status_version,
    reason: normalizedReason,
  });
  if (action !== "close") return common;

  return Object.freeze({
    ...common,
    expected_status: account.status,
    expected_principal_cents: account.principal_cents,
    expected_bonus_cents: account.bonus_cents,
    refund_tender: account.principal_cents === 0 ? null : refundTender,
  });
}

export function requestMemberLifecycle(
  commandClient: CommandPort,
  action: MemberLifecycleAction,
  body: MemberLifecycleBody,
): Promise<CommandResult> {
  return commandClient.execute(MEMBER_LIFECYCLE_COMMANDS[action], body);
}

/** Resume from the server-owned canonical snapshot; never echo lifecycle args. */
export function resumeMemberLifecycle(
  commandClient: CommandPort,
  command: MemberLifecycleCommand,
  confirmRef: string,
): Promise<CommandResult> {
  return commandClient.execute(command, {}, { confirmRef });
}
