/** DASCOM DL-206 wash-label profile (TSPL candidate; hardware-gated). */

import type { RenderedTicket } from "./template-render.js";
import {
  concatTspl,
  tsplCode128,
  tsplCut,
  tsplPrint,
  tsplStart,
  tsplText,
  type TsplBytes,
} from "./tspl.js";

const LABEL_WIDTH_MM = 58;
const LABEL_HEIGHT_MM = 50;

function dl206Lines(ticket: RenderedTicket): readonly string[] {
  return Object.freeze([
    ticket.lines[0] ?? "洗衣店",
    ticket.lines.find((line) => line.startsWith("票单号")) ?? "票单号",
    ticket.lines.find((line) => line.startsWith("顾客")) ?? "顾客",
    ...ticket.lines.filter((line) => line.includes("x")).slice(0, 3),
    `合计 ${ticket.totalText}`,
    `实收 ${ticket.paidText}`,
  ]);
}

/**
 * Build the DL-206 label including a feed-sized label and a cutter command.
 * Exact acceptance of this TSPL dialect remains a three-machine field gate.
 */
export function buildDl206Tspl(ticket: RenderedTicket): TsplBytes {
  if (ticket.barcode.length === 0) {
    throw new Error("DL-206 label requires a barcode");
  }
  const body = dl206Lines(ticket);
  const textParts = body.map((line, index) => tsplText(12, 12 + index * 32, line, 40));
  return concatTspl([
    tsplStart(LABEL_WIDTH_MM, LABEL_HEIGHT_MM),
    ...textParts,
    tsplCode128(12, 270, ticket.barcode, 56),
    tsplPrint(),
    tsplCut(),
  ]);
}
