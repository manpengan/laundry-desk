import type { CommandError } from "@laundry/contracts";

import type { BusChainData } from "./chain-adapter.js";
import type { CommandResult, DomainEvent, EventBus } from "./types.js";

export async function publishAfterCommit(
  eventBus: EventBus | undefined,
  events: readonly DomainEvent[],
): Promise<void> {
  if (eventBus === undefined || events.length === 0) return;
  await eventBus.publish(events);
}

export function preview(data: BusChainData): CommandResult {
  return Object.freeze({
    ok: true as const,
    data: Object.freeze({
      execution: "preview" as const,
      result: Object.freeze({
        parsed: data.parsed,
        policy: data.policy,
        invariants: data.invariants,
      }),
    }),
  });
}

export function executed(result: unknown): CommandResult {
  return Object.freeze({
    ok: true as const,
    data: Object.freeze({ execution: "executed" as const, result }),
  });
}

export function fail(error: CommandError): CommandResult {
  return Object.freeze({ ok: false as const, error });
}

/** Internal: convert post-chain hard failures into CommandResult without leaking stack. */
export class CommandBusTxnError extends Error {
  readonly commandError: CommandError;

  constructor(commandError: CommandError) {
    super(commandError.message);
    this.name = "CommandBusTxnError";
    this.commandError = commandError;
  }
}
