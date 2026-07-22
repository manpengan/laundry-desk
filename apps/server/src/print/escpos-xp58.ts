/**
 * Minimal ESC/POS builder for Xprinter XP-58 (58mm) — server process path.
 * Pure byte construction; no USB / OS spooler (mock device success).
 * Simplified port of edge-agent escpos-xp58 (no cross-package import).
 */

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

type Bytes = Uint8Array;

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

/** GS V m — partial cut (m=1) default. */
export function escCut(mode: 0 | 1 = 1): Bytes {
  return Uint8Array.of(GS, 0x56, mode);
}

export type Xp58TicketLines = Readonly<{
  ticketNo: string;
  lines?: readonly string[];
}>;

/**
 * Build a minimal XP-58 ticket byte stream from ticket number + optional lines.
 * Default body includes ticket header only when lines omitted.
 */
export function buildXp58EscPosFromTicket(ticketNo: string, lines?: readonly string[]): Bytes {
  const body =
    lines !== undefined && lines.length > 0
      ? lines
      : Object.freeze([`TICKET ${ticketNo}`, "laundry-desk", "---"]);
  const parts: Bytes[] = [escInit(), escAlign(1)];
  for (const line of body) {
    parts.push(escLine(line));
  }
  parts.push(escFeed(3), escCut(1));
  const bytes = concat(parts);
  if (bytes.byteLength === 0) {
    throw new Error("ESC/POS payload must be non-empty");
  }
  return bytes;
}
