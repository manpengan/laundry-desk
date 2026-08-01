import { M2_CONTRACT_DEFINITIONS } from "@laundry/contracts";

export type OfflineQueueMode = "grant" | "primary_lease";

const commandNamesForMode = (mode: OfflineQueueMode): ReadonlySet<string> =>
  new Set(
    M2_CONTRACT_DEFINITIONS.filter(
      (definition) => definition.kind === "command" && definition.offline_mode === mode,
    ).map((definition) => definition.name),
  );

const GRANT_COMMANDS = commandNamesForMode("grant");
const PRIMARY_LEASE_COMMANDS = commandNamesForMode("primary_lease");

if (GRANT_COMMANDS.size !== 6 || PRIMARY_LEASE_COMMANDS.size !== 3) {
  throw new TypeError(
    "Offline command partitions no longer match the reviewed 6 grant / 3 Primary set",
  );
}

export function offlineQueueModeForCommand(command: string): OfflineQueueMode | null {
  if (GRANT_COMMANDS.has(command)) return "grant";
  if (PRIMARY_LEASE_COMMANDS.has(command)) return "primary_lease";
  return null;
}

/** Ordinary offline receive may create debt or collect cash, never an unverified digital payment. */
export function isGrantCommandBodyAllowed(
  command: string,
  body: Readonly<Record<string, unknown>>,
): boolean {
  if (command !== "order.receive" || !("initial_payment" in body)) return true;
  const payment = body.initial_payment;
  return (
    typeof payment === "object" &&
    payment !== null &&
    !Array.isArray(payment) &&
    Reflect.get(payment, "method") === "cash"
  );
}
