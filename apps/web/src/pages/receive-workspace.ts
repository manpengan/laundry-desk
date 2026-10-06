import type { TicketPreview } from "@laundry/domain";
import type { CommandPort, CommandResult } from "../commands/types.js";
import {
  newLineDraft,
  type PaymentMethod,
  type ReceiveLineDraft,
  type ReceiveOrderResult,
} from "./order-form.js";
import { EMPTY_PRICING_SELECTION, type PricingSelection } from "./receive-pricing-selection.js";

export type ReceiveWorkspaceState = Readonly<{
  operationId: string;
  phone: string;
  name: string;
  paymentCents: string;
  paymentMethod: PaymentMethod;
  pricing: PricingSelection;
  note: string;
  draftId: string | null;
  lines: readonly ReceiveLineDraft[];
  focusedLineKey: string | null;
  busy: boolean;
  dirty: boolean;
  /** `queued`: the local service was down and the desktop offline queue took the receive. */
  phase: "editing" | "submitting" | "uncertain" | "complete" | "queued";
  result: ReceiveOrderResult | null;
  confirmedPaymentIntentIds: readonly string[];
  ticketPreview: TicketPreview | null;
  message: string;
  pendingBody: Readonly<Record<string, unknown>> | null;
  retryable: boolean;
  recoveryStatus: "browser" | "loading" | "ready" | "saving" | "error";
  recoveryMessage: string;
}>;

export function initialReceiveWorkspace(): ReceiveWorkspaceState {
  return Object.freeze({
    operationId: crypto.randomUUID(),
    phone: "",
    name: "",
    paymentCents: "0",
    paymentMethod: "cash",
    pricing: EMPTY_PRICING_SELECTION,
    note: "",
    draftId: null,
    lines: Object.freeze([newLineDraft(0)]),
    focusedLineKey: null,
    busy: false,
    dirty: false,
    phase: "editing",
    result: null,
    confirmedPaymentIntentIds: Object.freeze([]),
    ticketPreview: null,
    message: "",
    pendingBody: null,
    retryable: false,
    recoveryStatus: "browser",
    recoveryMessage: "浏览器中的未暂存内容不会在关闭后自动恢复，请使用暂存挂单。",
  });
}

/** One in-memory workspace per authenticated clerk. Never writes customer data to Web Storage. */
export function createReceiveWorkspace() {
  let state = initialReceiveWorkspace();
  let recoveredSubmit:
    | ((body: Readonly<Record<string, unknown>>, id: string) => Promise<CommandResult<unknown>>)
    | null = null;
  let recoveryRetry = async (): Promise<void> => undefined;
  const listeners = new Set<() => void>();
  const publish = (next: ReceiveWorkspaceState): void => {
    state = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  return Object.freeze({
    getSnapshot: () => state,
    setRecoverySubmit: (submit: typeof recoveredSubmit) => {
      recoveredSubmit = submit;
    },
    setRecoveryRetry: (retry: typeof recoveryRetry) => {
      recoveryRetry = retry;
    },
    retryRecovery: () => recoveryRetry(),
    submit: (port: CommandPort, body: Readonly<Record<string, unknown>>, id: string) =>
      recoveredSubmit === null
        ? port.execute<unknown>("order.receive", body, { operationId: id })
        : recoveredSubmit(body, id),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    patch: (changes: Partial<ReceiveWorkspaceState>) => publish({ ...state, ...changes }),
    setField: <K extends keyof ReceiveWorkspaceState>(
      key: K,
      value:
        | ReceiveWorkspaceState[K]
        | ((current: ReceiveWorkspaceState[K]) => ReceiveWorkspaceState[K]),
      dirty = true,
    ) => {
      const next = typeof value === "function" ? value(state[key]) : value;
      publish({ ...state, [key]: next, dirty: dirty || state.dirty });
    },
    reset: () => {
      if (state.phase === "uncertain" && state.recoveryStatus !== "browser") return;
      publish({
        ...initialReceiveWorkspace(),
        recoveryStatus: state.recoveryStatus,
        recoveryMessage: state.recoveryMessage,
      });
    },
    begin: (retry = false): boolean => {
      if (
        state.busy ||
        state.recoveryStatus === "loading" ||
        state.recoveryStatus === "error" ||
        (state.phase !== "editing" && !(retry && state.phase === "uncertain" && state.retryable))
      )
        return false;
      publish({ ...state, busy: true, phase: "submitting", message: "" });
      return true;
    },
  });
}

export type ReceiveWorkspace = ReturnType<typeof createReceiveWorkspace>;

export function hasReceiveWork(state: ReceiveWorkspaceState): boolean {
  return state.dirty || state.busy || state.phase === "uncertain";
}

/**
 * Whether leaving the page (reload, window close, quit) would lose work. On the desktop the
 * encrypted recovery journal restores the saved draft and any pending operation after a
 * reload or restart, so only edits it has not saved yet block; a browser keeps none of it.
 */
export function blocksUnload(state: ReceiveWorkspaceState): boolean {
  if (state.recoveryStatus === "browser") return hasReceiveWork(state);
  return state.dirty && state.recoveryStatus !== "ready";
}
