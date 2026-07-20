import { encodeGbk } from "./encode.ts";

/** TSPL command builder for Gprinter (TSC-compatible) label printers. */

export function cmd(line: string): Buffer {
  return Buffer.concat([Buffer.from(line, "ascii"), Buffer.from("\r\n")]);
}

/**
 * Escape TEXT/BARCODE string content for TSPL double-quoted fields.
 * - strip CR/LF (newline breaks command framing)
 * - replace ASCII " with fullwidth ＂ so quotes do not terminate the field
 * - optional hard truncate (GBK byte-safe at char level for spike)
 */
export function escapeTsplText(text: string, maxChars = 48): string {
  const flat = text.replace(/[\r\n]+/g, " ").replace(/"/g, "＂");
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function cmdGbk(prefix: string, text: string, suffix = '"'): Buffer {
  // TEXT x,y,"font",rotation,xmul,ymul,"content"
  return Buffer.concat([
    Buffer.from(prefix, "ascii"),
    encodeGbk(text),
    Buffer.from(`${suffix}\r\n`, "ascii"),
  ]);
}

export function sizeMm(widthMm: number, heightMm: number): Buffer {
  return cmd(`SIZE ${widthMm} mm, ${heightMm} mm`);
}

export function gapMm(gapMm: number, offsetMm = 0): Buffer {
  return cmd(`GAP ${gapMm} mm, ${offsetMm} mm`);
}

export function direction(dir: 0 | 1 = 1): Buffer {
  return cmd(`DIRECTION ${dir}`);
}

export function cls(): Buffer {
  return cmd("CLS");
}

export function text(
  x: number,
  y: number,
  font: string,
  content: string,
  xmul = 1,
  ymul = 1,
  rotation = 0,
  maxChars = 48,
): Buffer {
  const safe = escapeTsplText(content, maxChars);
  return cmdGbk(
    `TEXT ${x},${y},"${font}",${rotation},${xmul},${ymul},"`,
    safe,
  );
}

export function barcode(
  x: number,
  y: number,
  data: string,
  height = 60,
  readable = 1,
): Buffer {
  const safe = escapeTsplText(data, 32);
  return cmd(
    `BARCODE ${x},${y},"128",${height},${readable},0,2,2,"${safe}"`,
  );
}

export function print(sets = 1, copies = 1): Buffer {
  return cmd(`PRINT ${sets},${copies}`);
}

export function concat(...parts: Buffer[]): Buffer {
  return Buffer.concat(parts);
}

/** Layout helper: max Y for barcode bottom inside label height (8 dot/mm). */
export function labelHeightDots(heightMm: number): number {
  return Math.floor(heightMm * 8);
}
