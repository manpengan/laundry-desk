/**
 * D2 pairing: 60s single-use pairing code (architecture §10).
 * Pure in-process store — server redeem / bus validation is out of Edge scope.
 */
import { randomInt } from "node:crypto";

/** Architecture §10: short-lived one-time pairing window. */
export const PAIRING_CODE_TTL_MS = 60_000;

/** Architecture §10: 6-digit display code. */
export const PAIRING_CODE_DIGITS = 6;

export type PairingCodeIssue = Readonly<{
  code: string;
  createdAtMs: number;
  expiresAtMs: number;
}>;

export type PairingCodeStatus = Readonly<{
  active: boolean;
  expiresAtMs: number | null;
}>;

export type PairingConsumeOk = Readonly<{ ok: true }>;
export type PairingConsumeError = Readonly<{
  ok: false;
  error: "not_found" | "expired" | "already_consumed" | "mismatch";
}>;
export type PairingConsumeResult = PairingConsumeOk | PairingConsumeError;

type InternalRecord = {
  code: string;
  createdAtMs: number;
  expiresAtMs: number;
  consumed: boolean;
};

/**
 * Cryptographically uniform zero-padded decimal digits (no Math.random).
 */
export function generateDigitCode(digits: number = PAIRING_CODE_DIGITS): string {
  if (!Number.isInteger(digits) || digits < 1 || digits > 12) {
    throw new RangeError("digits must be an integer in [1, 12]");
  }
  const bound = 10 ** digits;
  return String(randomInt(0, bound)).padStart(digits, "0");
}

/**
 * In-memory one-time pairing code service.
 * Creating a new code invalidates any previous unconsumed code.
 */
export class OneTimePairingCodeService {
  private current: InternalRecord | null = null;

  create(nowMs: number = Date.now()): PairingCodeIssue {
    const code = generateDigitCode(PAIRING_CODE_DIGITS);
    const record: InternalRecord = {
      code,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + PAIRING_CODE_TTL_MS,
      consumed: false,
    };
    this.current = record;
    return Object.freeze({
      code: record.code,
      createdAtMs: record.createdAtMs,
      expiresAtMs: record.expiresAtMs,
    });
  }

  status(nowMs: number = Date.now()): PairingCodeStatus {
    const record = this.current;
    if (record === null || record.consumed || nowMs >= record.expiresAtMs) {
      return Object.freeze({ active: false, expiresAtMs: null });
    }
    return Object.freeze({ active: true, expiresAtMs: record.expiresAtMs });
  }

  /**
   * Single-use consume. Rejects expiry, mismatch, and double-consume.
   * Does not reveal whether a code existed after expiry (uniform expired).
   */
  consume(code: string, nowMs: number = Date.now()): PairingConsumeResult {
    const record = this.current;
    if (record === null) {
      return Object.freeze({ ok: false, error: "not_found" });
    }
    if (record.consumed) {
      return Object.freeze({ ok: false, error: "already_consumed" });
    }
    if (nowMs >= record.expiresAtMs) {
      return Object.freeze({ ok: false, error: "expired" });
    }
    if (code !== record.code) {
      return Object.freeze({ ok: false, error: "mismatch" });
    }
    record.consumed = true;
    return Object.freeze({ ok: true });
  }
}
