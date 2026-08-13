import type {
  DeliveryOrder,
  DeliveryOrderCancellationReason,
  DeliveryOrderStatus,
  DeliveryOrderTransitionInput,
} from "@laundry/contracts";

import type { SessionView } from "../auth/types.js";

export type DeliveryOrderRequestChannel = "list" | "detail" | "transition";

export type DeliveryOrderRequestToken = Readonly<{
  scope: string;
  channel: DeliveryOrderRequestChannel;
  generation: number;
  authorityKey: string;
}>;

export type DeliveryOrderRequestAuthority = Readonly<{
  scope: string;
  begin(channel: DeliveryOrderRequestChannel, authorityKey: string): DeliveryOrderRequestToken;
  invalidate(channel: DeliveryOrderRequestChannel): void;
  invalidateAll(): void;
  isCurrent(token: DeliveryOrderRequestToken): boolean;
}>;

export type DeliveryOrderStepUpCloseGate = Readonly<{
  markApproved(): void;
  reset(): void;
  /** True only when close represents an operator cancellation. */
  consumeClose(): boolean;
}>;

type ChannelState = Readonly<{ generation: number; authorityKey: string | null }>;
type AuthorityState = Readonly<Record<DeliveryOrderRequestChannel, ChannelState>>;

const EMPTY_CHANNEL: ChannelState = Object.freeze({ generation: 0, authorityKey: null });

function freshState(): AuthorityState {
  return Object.freeze({ list: EMPTY_CHANNEL, detail: EMPTY_CHANNEL, transition: EMPTY_CHANNEL });
}

export function deliveryOrderSessionScope(session: SessionView): string {
  const value = session.session;
  return JSON.stringify([
    value.session_id,
    value.session_version,
    value.org_id,
    value.store_id,
    value.staff_id,
    value.device_id,
    value.permission_version,
  ]);
}

export function createDeliveryOrderRequestAuthority(scope: string): DeliveryOrderRequestAuthority {
  let state = freshState();
  const advance = (channel: DeliveryOrderRequestChannel, authorityKey: string | null): number => {
    const generation = state[channel].generation + 1;
    state = Object.freeze({
      ...state,
      [channel]: Object.freeze({ generation, authorityKey }),
    });
    return generation;
  };
  return Object.freeze({
    scope,
    begin(channel, authorityKey) {
      return Object.freeze({
        scope,
        channel,
        generation: advance(channel, authorityKey),
        authorityKey,
      });
    },
    invalidate(channel) {
      advance(channel, null);
    },
    invalidateAll() {
      state = Object.freeze({
        list: Object.freeze({ generation: state.list.generation + 1, authorityKey: null }),
        detail: Object.freeze({ generation: state.detail.generation + 1, authorityKey: null }),
        transition: Object.freeze({
          generation: state.transition.generation + 1,
          authorityKey: null,
        }),
      });
    },
    isCurrent(token) {
      const current = state[token.channel];
      return (
        token.scope === scope &&
        token.generation === current.generation &&
        token.authorityKey === current.authorityKey
      );
    },
  });
}

export function createDeliveryOrderStepUpCloseGate(): DeliveryOrderStepUpCloseGate {
  let approved = false;
  return Object.freeze({
    markApproved() {
      approved = true;
    },
    reset() {
      approved = false;
    },
    consumeClose() {
      const invalidate = !approved;
      approved = false;
      return invalidate;
    },
  });
}

export function deliveryOrderListAuthorityKey(
  scope: string,
  status: DeliveryOrderStatus | "all",
): string {
  return JSON.stringify([scope, status]);
}

export function deliveryOrderDetailAuthorityKey(scope: string, deliveryOrderId: string): string {
  return JSON.stringify([scope, deliveryOrderId]);
}

export function deliveryOrderTransitionAuthorityKey(
  scope: string,
  body: DeliveryOrderTransitionInput,
): string {
  return JSON.stringify([
    scope,
    body.delivery_order_id,
    body.customer_id,
    body.expected_version,
    body.target_status,
    body.cancellation_reason ?? null,
  ]);
}

export function deliveryOrderTransitionStillMatches(
  body: DeliveryOrderTransitionInput,
  detail: DeliveryOrder | null,
  cancellationReason: DeliveryOrderCancellationReason,
): boolean {
  return (
    detail !== null &&
    body.delivery_order_id === detail.delivery_order_id &&
    body.customer_id === detail.customer_id &&
    body.expected_version === detail.version &&
    (body.target_status !== "cancelled" || body.cancellation_reason === cancellationReason)
  );
}
