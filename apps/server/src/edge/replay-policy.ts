export const OFFLINE_GRANT_ALLOWED_COMMANDS = Object.freeze([
  "order.receive",
  "order.hold",
  "customer.upsert",
  "print.ticket.enqueue",
  "print.ticket.retry",
  "print.ticket.reprint",
] as const);

export const PRIMARY_LEASE_ALLOWED_COMMANDS = Object.freeze([
  "order.pickup",
  "payment.collect",
  "payment.repay",
] as const);

export type ReplayAuthorizationKind = "grant" | "primary_lease";

const GRANT_COMMANDS = new Set<string>(OFFLINE_GRANT_ALLOWED_COMMANDS);
const PRIMARY_COMMANDS = new Set<string>(PRIMARY_LEASE_ALLOWED_COMMANDS);

export function replayCommandAllowed(kind: ReplayAuthorizationKind, command: string): boolean {
  return (kind === "grant" ? GRANT_COMMANDS : PRIMARY_COMMANDS).has(command);
}

/** Ordinary offline receipt is debt-only unless the initial tender is cash. */
export function grantCommandArgsAllowed(command: string, args: unknown): boolean {
  if (command !== "order.receive") return true;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return false;
  const initialPayment = (args as Readonly<Record<string, unknown>>).initial_payment;
  if (initialPayment === undefined) return true;
  if (
    typeof initialPayment !== "object" ||
    initialPayment === null ||
    Array.isArray(initialPayment)
  ) {
    return false;
  }
  return (initialPayment as Readonly<Record<string, unknown>>).method === "cash";
}

export function storedGrantAllowsCommand(
  kind: ReplayAuthorizationKind,
  allowedCommands: readonly string[],
  command: string,
): boolean {
  return kind === "primary_lease" || allowedCommands.includes(command);
}

export function timestampInWindow(timestamp: string, issuedAt: Date, notAfter: Date): boolean {
  const epochMs = Date.parse(timestamp);
  return Number.isFinite(epochMs) && epochMs >= issuedAt.getTime() && epochMs <= notAfter.getTime();
}
