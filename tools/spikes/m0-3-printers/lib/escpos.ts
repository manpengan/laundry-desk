import { encodeGbk } from "./encode.ts";

const ESC = 0x1b;
const GS = 0x1d;
const FS = 0x1c;
const LF = 0x0a;

/** 58mm @ ~203dpi printable width ≈ 384 dots (not full 58mm roll). */
export const XP58_PRINTABLE_DOTS = 384;

export type Code128Mode = "B" | "C" | "BC";

export type Code128Options = {
  mode?: Code128Mode;
  /** GS w n — module width 1–6; keep ≤2 on 58mm. */
  moduleWidth?: 1 | 2 | 3;
  height?: number;
};

export function concat(...parts: Buffer[]): Buffer {
  return Buffer.concat(parts);
}

export function init(): Buffer {
  return Buffer.from([ESC, 0x40]);
}

/** Align: 0 left, 1 center, 2 right */
export function align(mode: 0 | 1 | 2): Buffer {
  return Buffer.from([ESC, 0x61, mode]);
}

/** Character size: width/height multipliers 0–7 → nibble pack */
export function textSize(width: number, height: number): Buffer {
  const w = Math.min(7, Math.max(0, width));
  const h = Math.min(7, Math.max(0, height));
  return Buffer.from([GS, 0x21, (w << 4) | h]);
}

export function bold(on: boolean): Buffer {
  return Buffer.from([ESC, 0x45, on ? 1 : 0]);
}

export function line(text = ""): Buffer {
  return concat(encodeGbk(text), Buffer.from([LF]));
}

export function feed(lines = 1): Buffer {
  return Buffer.alloc(lines, LF);
}

/** Full cut (GS V 0). Partial cut = mode 1. */
export function cut(mode: 0 | 1 = 0): Buffer {
  return Buffer.from([GS, 0x56, mode]);
}

/**
 * GS V 66 n — feed `n` units then full cut (Epson/Xprinter family).
 * Use when knife sits past the print head (typically need extra feed).
 */
export function cutFeedFull(units = 3): Buffer {
  const n = Math.min(255, Math.max(0, units));
  return Buffer.from([GS, 0x56, 66, n]);
}

/** Alternate cutters used by some DASCOM firmwares. */
export function cutEscI(): Buffer {
  return Buffer.from([ESC, 0x69]);
}

export function cutEscM(): Buffer {
  return Buffer.from([ESC, 0x6d]);
}

/** Enable Chinese character mode (common on CN ESC/POS firmware). */
export function chineseOn(): Buffer {
  return Buffer.from([FS, 0x26]);
}

export function chineseOff(): Buffer {
  return Buffer.from([FS, 0x2e]);
}

/**
 * Build GS k 73 (CODE128) payload with mandatory code-set prefix.
 * Epson/Xprinter: first bytes must be {A / {B / {C (0x7B + set).
 */
export function encodeCode128Payload(
  data: string,
  mode: Code128Mode = "BC",
): Buffer {
  if (!/^[\x20-\x7E]+$/.test(data)) {
    throw new Error("CODE128 data must be printable ASCII");
  }
  if (mode === "B") {
    return Buffer.from(`{B${data}`, "ascii");
  }
  if (mode === "C") {
    if (!/^\d+$/.test(data) || data.length % 2 !== 0) {
      throw new Error("CODE128 C requires even-length digits");
    }
    return Buffer.from(`{C${data}`, "ascii");
  }
  // BC mixed: non-digit prefix in B, even digit run in C (narrower on 58mm).
  const match = /^([^0-9]*)(\d*)$/.exec(data);
  if (!match) {
    return Buffer.from(`{B${data}`, "ascii");
  }
  const prefix = match[1] ?? "";
  let digits = match[2] ?? "";
  if (!digits) {
    return Buffer.from(`{B${data}`, "ascii");
  }
  if (digits.length % 2 === 1) {
    // Keep last digit in B with prefix to avoid invalid C pairs.
    const last = digits.slice(-1);
    digits = digits.slice(0, -1);
    if (!digits) {
      return Buffer.from(`{B${data}`, "ascii");
    }
    return Buffer.from(`{B${prefix}${last}{C${digits}`, "ascii");
  }
  if (!prefix) {
    return Buffer.from(`{C${digits}`, "ascii");
  }
  return Buffer.from(`{B${prefix}{C${digits}`, "ascii");
}

/**
 * Count CODE128 symbols in a GS k 73 payload (with {A/{B/{C/{S escapes).
 * `{X` code-set selectors count as 1 symbol; CODE C digit pairs as 1.
 */
export function countCode128Symbols(payload: Buffer): number {
  const s = payload.toString("ascii");
  let i = 0;
  let symbols = 0;
  let codeSet: "A" | "B" | "C" = "B";
  while (i < s.length) {
    if (s[i] === "{" && i + 1 < s.length && "ABCS".includes(s[i + 1]!)) {
      const tag = s[i + 1]!;
      if (tag === "A" || tag === "B" || tag === "C") {
        codeSet = tag;
      }
      symbols += 1;
      i += 2;
      continue;
    }
    if (codeSet === "C") {
      if (i + 1 < s.length && /\d/.test(s[i]!) && /\d/.test(s[i + 1]!)) {
        symbols += 1;
        i += 2;
        continue;
      }
      // odd trailing digit falls back to one symbol
      symbols += 1;
      i += 1;
      continue;
    }
    symbols += 1;
    i += 1;
  }
  return symbols;
}

/**
 * Rough printed width in dots (moduleWidth = GS w n).
 * Formula: start(11) + n*11 + check(11) + stop(13) + quiet 10×2 = 11n + 55.
 * `payload` is the GS k body including `{B`/`{C` prefixes.
 */
export function estimateCode128Dots(
  payload: Buffer,
  moduleWidth: number,
): number {
  const n = countCode128Symbols(payload);
  const modules = 11 * n + 55;
  return modules * moduleWidth;
}

/** GS k 73 CODE128 with code-set prefix. Default BC + module 1 for 58mm. */
export function barcodeCode128(
  data: string,
  options: Code128Options = {},
): Buffer {
  const mode = options.mode ?? "BC";
  const moduleWidth = options.moduleWidth ?? 1;
  const height = options.height ?? 60;
  const payload = encodeCode128Payload(data, mode);
  return concat(
    Buffer.from([GS, 0x68, height]),
    Buffer.from([GS, 0x77, moduleWidth]),
    Buffer.from([GS, 0x48, 2]),
    Buffer.from([GS, 0x6b, 73, payload.length]),
    payload,
    Buffer.from([LF]),
  );
}

export function hr(char = "-", width = 32): Buffer {
  return line(char.repeat(width));
}
