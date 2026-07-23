/**
 * Minimal ESC/POS builder for Xprinter XP-58 (58mm).
 * No USB / OS spooler — pure byte construction for mock + future adapters.
 */
import type { RenderedTicket } from "./template-render.js";
import iconv from "iconv-lite";

const ESC = 0x1b;
const GS = 0x1d;
const FS = 0x1c;
const LF = 0x0a;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/u;

type Bytes = Uint8Array<ArrayBufferLike>;

function concat(parts: readonly Bytes[]): Bytes {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/** UTF-8 text encoding for skeleton payloads (GBK adapter can replace later). */
function encodeText(text: string): Bytes {
  return new Uint8Array(iconv.encode(text, "gbk"));
}

/** ESC @ — initialize printer. */
export function escInit(): Bytes {
  return Uint8Array.of(ESC, 0x40);
}

/** ESC a n — alignment: 0 left, 1 center, 2 right. */
export function escAlign(mode: 0 | 1 | 2): Bytes {
  return Uint8Array.of(ESC, 0x61, mode);
}

/** FS & — enable the Chinese code table selected by the physical XP-58 profile. */
export function escChineseOn(): Bytes {
  return Uint8Array.of(FS, 0x26);
}

/** One text line terminated by LF. */
export function escLine(text: string): Bytes {
  return concat([encodeText(text), Uint8Array.of(LF)]);
}

/** n line feeds. */
export function escFeed(lines = 1): Bytes {
  const n = Math.min(255, Math.max(0, lines));
  return new Uint8Array(n).fill(LF);
}

/** GS V m — partial cut (m=1) default; full cut m=0. */
export function escCut(mode: 0 | 1 = 1): Bytes {
  return Uint8Array.of(GS, 0x56, mode);
}

/** GS k m — CODE128 with explicit Set B prefix and 58mm-safe module width. */
export function escCode128(data: string, moduleWidth = 1, height = 56): Bytes {
  if (!PRINTABLE_ASCII.test(data) || data.length > 120) {
    throw new Error("XP-58 CODE128 data must be printable ASCII (1-120 characters)");
  }
  if (!Number.isInteger(moduleWidth) || moduleWidth < 1 || moduleWidth > 2) {
    throw new Error("XP-58 CODE128 module width must be 1 or 2");
  }
  if (!Number.isInteger(height) || height < 24 || height > 255) {
    throw new Error("XP-58 CODE128 height must be an integer between 24 and 255");
  }
  const payload = new TextEncoder().encode(`{B${data}`);
  return concat([
    Uint8Array.of(GS, 0x68, height),
    Uint8Array.of(GS, 0x77, moduleWidth),
    Uint8Array.of(GS, 0x48, 2),
    Uint8Array.of(GS, 0x6b, 73, payload.byteLength),
    payload,
    Uint8Array.of(LF),
  ]);
}

/** Build a minimal XP-58 ticket byte stream from a rendered template. */
export function buildXp58EscPos(ticket: RenderedTicket): Bytes {
  if (!ticket.barcodeFitsXp58) {
    throw new Error(`XP-58 barcode exceeds ${ticket.printableDots} printable dots`);
  }
  const parts: Bytes[] = [escInit(), escChineseOn(), escAlign(1)];
  for (const line of ticket.lines) {
    parts.push(escLine(line));
  }
  parts.push(escCode128(ticket.barcode, ticket.barcodeModuleWidth));
  parts.push(escFeed(3), escCut(1));
  const bytes = concat(parts);
  if (bytes.byteLength === 0) {
    throw new Error("ESC/POS payload must be non-empty");
  }
  return bytes;
}
