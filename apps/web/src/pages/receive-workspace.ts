import type { TicketPreview } from "@laundry/domain";
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
  phase: "editing" | "submitting" | "uncertain" | "complete";
  result: ReceiveOrderResult | null;
  ticketPreview: TicketPreview | null;
  message: string;
  pendingBody: Readonly<Record<string, unknown>> | null;
  retryable: boolean;
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
    ticketPreview: null,
    message: "",
    pendingBody: null,
    retryable: false,
  });
}

/** One in-memory workspace per authenticated clerk. Never writes customer data to Web Storage. */
export function createReceiveWorkspace() {
  let state = initialReceiveWorkspace();
  const listeners = new Set<() => void>();
  const publish = (next: ReceiveWorkspaceState): void => {
    state = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  return Object.freeze({
    getSnapshot: () => state,
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
    reset: () => publish(initialReceiveWorkspace()),
    begin: (retry = false): boolean => {
      if (
        state.busy ||
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
