import type {
  CustomerPortalGarmentProgressResult,
  CustomerPortalLoginInput,
  CustomerPortalOrderSummary,
} from "@laundry/contracts";

import type { CustomerPortalClient } from "./client.js";
import type { CustomerPortalDetail } from "./CustomerPortalOrders.js";
import { newestOrderFirst } from "./model.js";

export type CustomerPortalState = Readonly<{
  authenticated: boolean | null;
  orders: readonly CustomerPortalOrderSummary[];
  selectedOrderId: string | null;
  detail: CustomerPortalDetail | null;
  progress: Readonly<Record<string, CustomerPortalGarmentProgressResult>>;
  busy: boolean;
  error: string | null;
}>;

export type CustomerPortalController = Readonly<{
  getSnapshot(): CustomerPortalState;
  subscribe(listener: () => void): () => void;
  resume(): Promise<void>;
  login(input: CustomerPortalLoginInput): Promise<void>;
  logout(): Promise<void>;
  loadOrders(): Promise<void>;
  selectOrder(orderId: string): Promise<void>;
  loadProgress(orderId: string, garmentId: string): Promise<void>;
  dispose(): void;
}>;

type TimerHandle = ReturnType<typeof setTimeout>;

type ControllerTiming = Readonly<{
  nowMs?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}>;

type Operation = Readonly<{
  key: string;
  generation: number;
  controller: AbortController;
}>;

const EMPTY_PROGRESS = Object.freeze({});
const EMPTY_ORDERS = Object.freeze([]);
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function clearedState(authenticated: boolean | null): CustomerPortalState {
  return Object.freeze({
    authenticated,
    orders: EMPTY_ORDERS,
    selectedOrderId: null,
    detail: null,
    progress: EMPTY_PROGRESS,
    busy: false,
    error: null,
  });
}

export function createCustomerPortalController(
  client: CustomerPortalClient,
  timing: ControllerTiming = {},
): CustomerPortalController {
  const nowMs = timing.nowMs ?? Date.now;
  const setTimer = timing.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = timing.clearTimer ?? ((handle) => clearTimeout(handle));
  let state = clearedState(null);
  let generation = 0;
  let listeners: ReadonlySet<() => void> = new Set();
  let operations: ReadonlyMap<string, Operation> = new Map();
  let expiryTimer: TimerHandle | null = null;

  const publish = (patch: Partial<CustomerPortalState>): void => {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener();
  };

  const abortMatching = (matches: (key: string) => boolean): void => {
    const retained = new Map<string, Operation>();
    for (const [key, operation] of operations) {
      if (matches(key)) operation.controller.abort();
      else retained.set(key, operation);
    }
    operations = retained;
  };

  const clearExpiry = (): void => {
    if (expiryTimer !== null) clearTimer(expiryTimer);
    expiryTimer = null;
  };

  const advanceSession = (authenticated: boolean | null): number => {
    generation += 1;
    clearExpiry();
    abortMatching(() => true);
    operations = new Map();
    state = clearedState(authenticated);
    for (const listener of listeners) listener();
    return generation;
  };

  const armExpiry = (expiresAt: number, expectedGeneration: number): boolean => {
    clearExpiry();
    if (expectedGeneration !== generation || state.authenticated !== true) return false;
    const expire = (): void => {
      expiryTimer = null;
      if (expectedGeneration !== generation || state.authenticated !== true) return;
      const remaining = expiresAt * 1_000 - nowMs();
      if (remaining > 0) {
        expiryTimer = setTimer(expire, Math.min(remaining, MAX_TIMER_DELAY_MS));
        return;
      }
      client.invalidateLocalSession();
      advanceSession(false);
    };
    const remaining = expiresAt * 1_000 - nowMs();
    if (remaining <= 0) {
      expire();
      return false;
    }
    expiryTimer = setTimer(expire, Math.min(remaining, MAX_TIMER_DELAY_MS));
    return true;
  };

  const begin = (key: string, expectedGeneration = generation): Operation | null => {
    if (expectedGeneration !== generation) return null;
    abortMatching((activeKey) => activeKey === key);
    const operation = Object.freeze({ key, generation, controller: new AbortController() });
    const next = new Map(operations);
    next.set(key, operation);
    operations = next;
    publish({ busy: true });
    return operation;
  };

  const isCurrent = (operation: Operation): boolean =>
    operation.generation === generation &&
    !operation.controller.signal.aborted &&
    operations.get(operation.key) === operation;

  const complete = (operation: Operation, patch: Partial<CustomerPortalState>): boolean => {
    if (!isCurrent(operation)) return false;
    const next = new Map(operations);
    next.delete(operation.key);
    operations = next;
    publish({ ...patch, busy: next.size > 0 });
    return true;
  };

  const loadOrdersForGeneration = async (expectedGeneration: number): Promise<void> => {
    if (state.authenticated !== true) return;
    const operation = begin("orders", expectedGeneration);
    if (operation === null) return;
    const result = await client.listOrders(20, operation.controller.signal);
    if (!isCurrent(operation)) return;
    if (!result.ok) {
      if (result.error.code === "AUTHENTICATION_FAILED") advanceSession(false);
      else complete(operation, { error: result.error.message });
      return;
    }
    complete(operation, { orders: newestOrderFirst(result.data), error: null });
  };

  const resume = async (): Promise<void> => {
    const expectedGeneration = advanceSession(null);
    const operation = begin("session", expectedGeneration);
    if (operation === null) return;
    const result = await client.resume(operation.controller.signal);
    if (!isCurrent(operation)) return;
    if (!result.ok) {
      complete(operation, { authenticated: false, error: null });
      return;
    }
    complete(operation, { authenticated: true, error: null });
    if (!armExpiry(result.data.expires_at, expectedGeneration)) return;
    await loadOrdersForGeneration(expectedGeneration);
  };

  const login = async (input: CustomerPortalLoginInput): Promise<void> => {
    const expectedGeneration = advanceSession(false);
    const operation = begin("session", expectedGeneration);
    if (operation === null) return;
    const result = await client.login(input, operation.controller.signal);
    if (!isCurrent(operation)) return;
    if (!result.ok) {
      complete(operation, { error: "验证失败，请检查信息后再试" });
      return;
    }
    complete(operation, { authenticated: true, error: null });
    if (!armExpiry(result.data.expires_at, expectedGeneration)) return;
    await loadOrdersForGeneration(expectedGeneration);
  };

  const logout = async (): Promise<void> => {
    const expectedGeneration = advanceSession(false);
    const operation = begin("session", expectedGeneration);
    if (operation === null) return;
    const result = await client.logout(operation.controller.signal);
    if (!isCurrent(operation)) return;
    complete(operation, {
      error: result.ok ? null : "退出请求未完成，本机订单信息已清除",
    });
  };

  const selectOrder = async (orderId: string): Promise<void> => {
    if (state.authenticated !== true) return;
    const expectedGeneration = generation;
    abortMatching((key) => key === "detail" || key.startsWith("progress:"));
    publish({
      selectedOrderId: orderId,
      detail: null,
      progress: EMPTY_PROGRESS,
      busy: operations.size > 0,
      error: null,
    });
    const operation = begin("detail", expectedGeneration);
    if (operation === null) return;
    const [order, receipt, garments] = await Promise.all([
      client.getOrder(orderId, operation.controller.signal),
      client.getReceipt(orderId, operation.controller.signal),
      client.listGarments(orderId, operation.controller.signal),
    ]);
    if (!isCurrent(operation)) return;
    if (!order.ok || !receipt.ok || !garments.ok) {
      const authenticationFailed =
        (!order.ok && order.error.code === "AUTHENTICATION_FAILED") ||
        (!receipt.ok && receipt.error.code === "AUTHENTICATION_FAILED") ||
        (!garments.ok && garments.error.code === "AUTHENTICATION_FAILED");
      if (authenticationFailed) advanceSession(false);
      else complete(operation, { error: "订单暂时无法读取，请刷新后重试" });
      return;
    }
    complete(operation, {
      detail: Object.freeze({ order: order.data, receipt: receipt.data, garments: garments.data }),
      progress: EMPTY_PROGRESS,
      error: null,
    });
  };

  const loadProgress = async (orderId: string, garmentId: string): Promise<void> => {
    if (
      state.authenticated !== true ||
      state.selectedOrderId !== orderId ||
      state.detail?.garments.garments.some((garment) => garment.garment_id === garmentId) !== true
    ) {
      return;
    }
    const operation = begin(`progress:${garmentId}`);
    if (operation === null) return;
    const result = await client.getGarmentProgress(orderId, garmentId, operation.controller.signal);
    if (!isCurrent(operation)) return;
    if (!result.ok) {
      if (result.error.code === "AUTHENTICATION_FAILED") advanceSession(false);
      else complete(operation, { error: "进度节点暂时无法读取" });
      return;
    }
    complete(operation, {
      progress: Object.freeze({ ...state.progress, [garmentId]: result.data }),
      error: null,
    });
  };

  const dispose = (): void => {
    generation += 1;
    clearExpiry();
    abortMatching(() => true);
    operations = new Map();
    state = clearedState(null);
  };

  return Object.freeze({
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners = new Set([...listeners, listener]);
      return () => {
        listeners = new Set([...listeners].filter((candidate) => candidate !== listener));
      };
    },
    resume,
    login,
    logout,
    loadOrders: () => loadOrdersForGeneration(generation),
    selectOrder,
    loadProgress,
    dispose,
  });
}
