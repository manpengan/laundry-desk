import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import { ChannelProtocolError, type ChannelClock, type ChannelHttpResponse } from "./types.js";

export const channelClock: ChannelClock = Object.freeze({
  nowMs: Date.now,
  nonce: () => randomBytes(16).toString("hex"),
});
const ALLOWED_SKEW_MS = 5 * 60_000;

export function requireRsaKey(pem: string, kind: "private" | "public"): void {
  const key = kind === "private" ? createPrivateKey(pem) : createPublicKey(pem);
  const size = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (key.asymmetricKeyType !== "rsa" || size < 2048 || size > 4096)
    throw new ChannelProtocolError("CHANNEL_RESPONSE_INVALID");
}
export function rsaSign(value: string, privateKey: string): string {
  return sign("RSA-SHA256", Buffer.from(value, "utf8"), privateKey).toString("base64");
}
export function rsaVerify(value: string, signature: string, publicKey: string): void {
  if (
    !/^[A-Za-z0-9+/]{342,684}={0,2}$/u.test(signature) ||
    !verify("RSA-SHA256", Buffer.from(value, "utf8"), publicKey, Buffer.from(signature, "base64"))
  )
    throw new ChannelProtocolError("CHANNEL_SIGNATURE_INVALID");
}
export function verifiedTimestamp(value: string, nowMs: number, unit: "seconds" | "ms"): void {
  if (!/^\d{10,13}$/u.test(value)) throw new ChannelProtocolError("CHANNEL_SIGNATURE_INVALID");
  const epoch = Number(value) * (unit === "seconds" ? 1000 : 1);
  if (!Number.isSafeInteger(epoch) || Math.abs(nowMs - epoch) > ALLOWED_SKEW_MS)
    throw new ChannelProtocolError("CHANNEL_SIGNATURE_INVALID");
}
export function header(response: ChannelHttpResponse, name: string): string {
  const value = response.headers[name];
  if (value === undefined || value.length > 1024 || /[\r\n]/u.test(value))
    throw new ChannelProtocolError("CHANNEL_SIGNATURE_INVALID");
  return value;
}
export function parseChannelJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ChannelProtocolError("CHANNEL_RESPONSE_INVALID");
  }
}
export function yuan(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > 5_000_000)
    throw new ChannelProtocolError("CHANNEL_RESPONSE_INVALID");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
export function fen(value: string): number {
  if (!/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/u.test(value))
    throw new ChannelProtocolError("CHANNEL_RESPONSE_INVALID");
  const [whole, fraction] = value.split(".");
  const cents = Number(whole) * 100 + Number((fraction ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > 5_000_000)
    throw new ChannelProtocolError("CHANNEL_RESPONSE_INVALID");
  return cents;
}
export function providerDate(value: string): Date {
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)
    ? `${value.replace(" ", "T")}+08:00`
    : value;
  const result = new Date(iso);
  if (!Number.isFinite(result.getTime()))
    throw new ChannelProtocolError("CHANNEL_RESPONSE_INVALID");
  return result;
}
