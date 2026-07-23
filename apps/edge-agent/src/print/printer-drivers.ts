/** Printer-family selection stays in Edge; templates never carry device paths or bytes. */

import { buildXp58EscPos } from "./escpos-xp58.js";
import { buildDl206Tspl } from "./tspl-dl206.js";
import { buildGp3120Tspl } from "./tspl-gp3120.js";
import type { RenderedTicket } from "./template-render.js";

export type PrinterFamily = "xp58" | "dl206" | "gp3120";

export function buildPrinterPayload(
  family: PrinterFamily,
  ticket: RenderedTicket,
): Uint8Array<ArrayBufferLike> {
  switch (family) {
    case "xp58":
      return buildXp58EscPos(ticket);
    case "dl206":
      return buildDl206Tspl(ticket);
    case "gp3120":
      return buildGp3120Tspl(ticket);
  }
}
