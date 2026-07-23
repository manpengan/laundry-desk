/** Gprinter GP-3120 compact TSPL sticker profile. */

import type { RenderedTicket } from "./template-render.js";
import { concatTspl, tsplCode128, tsplPrint, tsplStart, tsplText, type TsplBytes } from "./tspl.js";

const LABEL_WIDTH_MM = 40;
const LABEL_HEIGHT_MM = 30;

function gp3120Lines(ticket: RenderedTicket): readonly string[] {
  return Object.freeze([
    ticket.lines[0] ?? "洗衣店",
    ticket.lines.find((line) => line.startsWith("票单号")) ?? "票单号",
    ticket.lines.find((line) => line.startsWith("顾客")) ?? "顾客",
    `${ticket.totalText} / ${ticket.paidText}`,
  ]);
}

/** Build one compact 40×30mm sticker. GP-3120 has no cutter command. */
export function buildGp3120Tspl(ticket: RenderedTicket): TsplBytes {
  if (ticket.barcode.length === 0) {
    throw new Error("GP-3120 label requires a barcode");
  }
  const body = gp3120Lines(ticket);
  return concatTspl([
    tsplStart(LABEL_WIDTH_MM, LABEL_HEIGHT_MM),
    ...body.map((line, index) => tsplText(12, 10 + index * 28, line, 32)),
    tsplCode128(12, 132, ticket.barcode, 44),
    tsplPrint(),
  ]);
}
