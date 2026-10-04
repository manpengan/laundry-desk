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
/** The provider's public error code from an error body; never its free-text message. */
export function providerErrorCode(body: string): string | null {
  try {
    const value = JSON.parse(body) as { code?: unknown; sub_code?: unknown };
    for (const candidate of [value.sub_code, value.code])
      if (typeof candidate === "string" && /^[A-Za-z0-9_.]{1,64}$/u.test(candidate))
        return candidate;
  } catch {
    // Not JSON: only the HTTP status is known.
  }
  return null;
}
/** WeChat documents RFC 3339 seconds with an explicit offset, e.g. 2026-10-04T09:31:02+08:00. */
export function shanghaiTimestamp(date: Date): string {
  const local = new Date(date.getTime() + 8 * 60 * 60_000).toISOString();
  return `${local.slice(0, 19)}+08:00`;
}
/** Provider answers that do not match the expected shape are "result unknown", not a crash. */
export function parseProviderResponse<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ChannelProtocolError) throw error;
    throw new ChannelProtocolError("CHANNEL_RESPONSE_INVALID");
  }
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
