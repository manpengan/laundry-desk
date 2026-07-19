import { encodeGbk } from "./encode.ts";

/** TSPL command builder for Gprinter (TSC-compatible) label printers. */

export function cmd(line: string): Buffer {
  return Buffer.concat([Buffer.from(line, "ascii"), Buffer.from("\r\n")]);
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
): Buffer {
  return cmdGbk(`TEXT ${x},${y},"${font}",${rotation},${xmul},${ymul},"`, content);
}

export function barcode(
  x: number,
  y: number,
  data: string,
  height = 60,
  readable = 1,
): Buffer {
  // CODE128
  return cmd(
    `BARCODE ${x},${y},"128",${height},${readable},0,2,2,"${data}"`,
  );
}

export function print(sets = 1, copies = 1): Buffer {
  return cmd(`PRINT ${sets},${copies}`);
}

export function concat(...parts: Buffer[]): Buffer {
  return Buffer.concat(parts);
}
