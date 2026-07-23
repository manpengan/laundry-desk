/**
 * Strict TSPL byte helpers shared by label-printer families.
 *
 * The Edge process owns these bytes. Callers receive status/receipts only; never
 * interpolate renderer supplied command fragments into this module.
 */

import iconv from "iconv-lite";

export type TsplBytes = Uint8Array<ArrayBufferLike>;

const encoder = new TextEncoder();
const CONTROL = /[\u0000-\u001f\u007f]/u;
const ASCII_BARCODE = /^[\x20-\x7e]+$/u;

function command(value: string): TsplBytes {
  return encoder.encode(`${value}\r\n`);
}

function gbkText(value: string): TsplBytes {
  return new Uint8Array(iconv.encode(value, "gbk"));
}

function assertCoordinate(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 9_999) {
    throw new Error(`${name} must be an integer printer coordinate`);
  }
}

function truncateCodePoints(value: string, maxCharacters: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return value;
  return `${characters.slice(0, Math.max(0, maxCharacters - 1)).join("")}…`;
}

/**
 * Makes a variable safe for a TSPL double-quoted field. Quotes are rendered as
 * fullwidth glyphs; command/control bytes are rejected rather than normalized.
 */
export function quoteTsplText(value: string, maxCharacters = 48): string {
  if (CONTROL.test(value)) {
    throw new Error("TSPL template value contains a control character");
  }
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
    throw new Error("TSPL maxCharacters must be a positive integer");
  }
  return truncateCodePoints(value.replaceAll('"', "＂"), maxCharacters);
}

export function concatTspl(parts: readonly TsplBytes[]): TsplBytes {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export function tsplStart(widthMm: number, heightMm: number, gapMm = 2): TsplBytes {
  for (const [name, value] of [
    ["widthMm", widthMm],
    ["heightMm", heightMm],
    ["gapMm", gapMm],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > 500) {
      throw new Error(`${name} must be an integer between 1 and 500`);
    }
  }
  return concatTspl([
    command(`SIZE ${widthMm} mm, ${heightMm} mm`),
    command(`GAP ${gapMm} mm, 0 mm`),
    command("DIRECTION 1"),
    command("CODEPAGE 936"),
    command("CLS"),
  ]);
}

export function tsplText(x: number, y: number, value: string, maxCharacters = 48): TsplBytes {
  assertCoordinate(x, "x");
  assertCoordinate(y, "y");
  const text = quoteTsplText(value, maxCharacters);
  return concatTspl([
    encoder.encode(`TEXT ${x},${y},"TSS16.BF2",0,1,1,"`),
    gbkText(text),
    command('"'),
  ]);
}

export function tsplCode128(x: number, y: number, value: string, height: number): TsplBytes {
  assertCoordinate(x, "x");
  assertCoordinate(y, "y");
  if (!Number.isInteger(height) || height < 16 || height > 240) {
    throw new Error("TSPL barcode height must be an integer between 16 and 240");
  }
  if (!ASCII_BARCODE.test(value) || value.length > 64 || value.includes('"')) {
    throw new Error("TSPL CODE128 data must be printable ASCII without quotes");
  }
  return command(`BARCODE ${x},${y},"128",${height},1,0,2,2,"${value}"`);
}

export function tsplPrint(): TsplBytes {
  return command("PRINT 1,1");
}

/** Cutter command is used only by the DL-206 wash-label profile. */
export function tsplCut(): TsplBytes {
  return command("CUT");
}
