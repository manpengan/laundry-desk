import { encodeGbk } from "./encode.ts";

const ESC = 0x1b;
const GS = 0x1d;
const FS = 0x1c;
const LF = 0x0a;

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

/** Code39-ish barcode via GS k — length-prefixed CODE128 subset B where supported. */
export function barcodeCode128(data: string): Buffer {
  const payload = Buffer.from(data, "ascii");
  return concat(
    Buffer.from([GS, 0x68, 60]), // height
    Buffer.from([GS, 0x77, 2]), // width
    Buffer.from([GS, 0x48, 2]), // HRI below
    Buffer.from([GS, 0x6b, 73, payload.length]),
    payload,
    Buffer.from([LF]),
  );
}

export function hr(char = "-", width = 32): Buffer {
  return line(char.repeat(width));
}
