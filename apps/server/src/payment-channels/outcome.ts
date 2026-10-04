import { ZodError } from "zod";
import { ChannelProtocolError } from "./types.js";

/** Unpaid codes are ended (WeChat close / Alipay cancel) after expiry plus this grace. */
export const EXPIRY_GRACE_MS = 2 * 60_000;
/** Unresolvable intents stop automatic polling and wait for an administrator. */
export const REVIEW_AFTER_MS = 24 * 60 * 60_000;

/** Provider answers proving the order exists although our request reported a failure. */
const ORDER_EXISTS = new Set([
  "ORDERPAID",
  "OUT_TRADE_NO_USED",
  "ORDER_CLOSED",
  "ACQ.TRADE_HAS_SUCCESS",
  "ACQ.TRADE_HAS_CLOSE",
  "ACQ.TRADE_HAS_FINISHED",
]);
/** The order was paid before it could be closed: settle it instead. */
export const ORDER_PAID = new Set(["ORDERPAID", "ACQ.TRADE_HAS_SUCCESS", "ACQ.TRADE_HAS_FINISHED"]);
/** The order is already closed at the provider. */
export const ORDER_CLOSED = new Set(["ORDER_CLOSED", "ACQ.TRADE_HAS_CLOSE"]);

/** Protocol errors stay typed; malformed provider answers are "result unknown", not a 500. */
export function channelFailure(error: unknown): ChannelProtocolError {
  if (error instanceof ChannelProtocolError) return error;
  if (error instanceof ZodError) return new ChannelProtocolError("CHANNEL_RESPONSE_INVALID");
  throw error;
}

/** True only when the provider cannot have created a collectable order. */
export function notCreated(failure: ChannelProtocolError): boolean {
  if (failure.code === "CHANNEL_NOT_SENT") return true;
  return (
    failure.code === "CHANNEL_REJECTED" &&
    (failure.providerCode === null || !ORDER_EXISTS.has(failure.providerCode))
  );
}

export const pastGrace = (expiresAt: Date, now = Date.now()) =>
  now > expiresAt.getTime() + EXPIRY_GRACE_MS;
