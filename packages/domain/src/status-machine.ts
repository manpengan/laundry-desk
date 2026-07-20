/**
 * @file status-machine.ts
 * @description B3 模块：order/garment 状态机（显式转移表、Fulfillment 模式坍缩、高危终态约束）
 * 遵循 GEMINI.md 红线：严格类型安全，显式转移表，穷举单测。
 */

export type GarmentStatus =
  "received" | "washing" | "ready" | "racked" | "picked_up" | "delivered" | "reworked" | "lost";

export const ALL_GARMENT_STATUSES: readonly GarmentStatus[] = [
  "received",
  "washing",
  "ready",
  "racked",
  "picked_up",
  "delivered",
  "reworked",
  "lost",
] as const;

export class InvalidStateTransitionError extends Error {
  readonly currentStatus: GarmentStatus;
  readonly targetStatus: GarmentStatus;
  readonly fulfillmentEnabled: boolean;

  constructor(
    currentStatus: GarmentStatus,
    targetStatus: GarmentStatus,
    fulfillmentEnabled: boolean,
  ) {
    super(
      `Invalid garment status transition: cannot transition from '${currentStatus}' to '${targetStatus}' (fulfillmentEnabled=${fulfillmentEnabled})`,
    );
    this.name = "InvalidStateTransitionError";
    this.currentStatus = currentStatus;
    this.targetStatus = targetStatus;
    this.fulfillmentEnabled = fulfillmentEnabled;
  }
}

/**
 * 完整履约模式 (fulfillmentEnabled = true) 下的显式状态转移表
 */
const FULL_TRANSITION_MAP: Record<GarmentStatus, readonly GarmentStatus[]> = {
  received: ["washing", "picked_up", "delivered", "lost"],
  washing: ["ready", "reworked", "lost"],
  ready: ["racked", "picked_up", "delivered", "reworked", "lost"],
  racked: ["picked_up", "delivered", "reworked", "lost"],
  reworked: ["washing", "ready", "lost"],
  picked_up: [], // 终态
  delivered: [], // 终态
  lost: [], // 高危终态，绝对不可转出
};

/**
 * 极简/关闭履约模式 (fulfillmentEnabled = false) 下的坍缩状态转移表
 */
const COLLAPSED_TRANSITION_MAP: Record<GarmentStatus, readonly GarmentStatus[]> = {
  received: ["picked_up", "delivered", "lost"],
  washing: [],
  ready: [],
  racked: [],
  reworked: [],
  picked_up: [],
  delivered: [],
  lost: [],
};

/**
 * 查询指定状态转移是否合法
 * @param currentStatus 当前状态
 * @param targetStatus 目标状态
 * @param options.fulfillmentEnabled 是否开启履约精细化流转（默认 true）
 */
export function canTransition(
  currentStatus: GarmentStatus,
  targetStatus: GarmentStatus,
  options?: { fulfillmentEnabled?: boolean },
): boolean {
  const fulfillmentEnabled = options?.fulfillmentEnabled ?? true;
  const transitionMap = fulfillmentEnabled ? FULL_TRANSITION_MAP : COLLAPSED_TRANSITION_MAP;

  const validTargets = transitionMap[currentStatus];
  if (!validTargets) {
    return false;
  }

  return validTargets.includes(targetStatus);
}

/**
 * 执行状态转移。如果非法则抛出 InvalidStateTransitionError 异常
 */
export function transition(
  currentStatus: GarmentStatus,
  targetStatus: GarmentStatus,
  options?: { fulfillmentEnabled?: boolean },
): GarmentStatus {
  const fulfillmentEnabled = options?.fulfillmentEnabled ?? true;
  if (!canTransition(currentStatus, targetStatus, { fulfillmentEnabled })) {
    throw new InvalidStateTransitionError(currentStatus, targetStatus, fulfillmentEnabled);
  }
  return targetStatus;
}

/**
 * 获取当前状态可以合法转移的目标状态列表
 */
export function getValidTransitions(
  currentStatus: GarmentStatus,
  options?: { fulfillmentEnabled?: boolean },
): GarmentStatus[] {
  const fulfillmentEnabled = options?.fulfillmentEnabled ?? true;
  const transitionMap = fulfillmentEnabled ? FULL_TRANSITION_MAP : COLLAPSED_TRANSITION_MAP;

  return [...(transitionMap[currentStatus] || [])];
}
