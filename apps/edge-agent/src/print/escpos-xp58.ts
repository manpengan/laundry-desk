/**
 * Minimal ESC/POS builder for Xprinter XP-58 (58mm).
 * No USB / OS spooler — pure byte construction for mock + future adapters.
 */
import type { RenderedTicket } from "./template-render.js";

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

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
  return new TextEncoder().encode(text);
}

/** ESC @ — initialize printer. */
export function escInit(): Bytes {
  return Uint8Array.of(ESC, 0x40);
}

/** ESC a n — alignment: 0 left, 1 center, 2 right. */
export function escAlign(mode: 0 | 1 | 2): Bytes {
  return Uint8Array.of(ESC, 0x61, mode);
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

/** Build a minimal XP-58 ticket byte stream from a rendered template. */
export function buildXp58EscPos(ticket: RenderedTicket): Bytes {
  const parts: Bytes[] = [escInit(), escAlign(1)];
  for (const line of ticket.lines) {
    parts.push(escLine(line));
  }
  parts.push(escFeed(3), escCut(1));
  const bytes = concat(parts);
  if (bytes.byteLength === 0) {
    throw new Error("ESC/POS payload must be non-empty");
  }
  return bytes;
}
