import { open } from "node:fs/promises";
import { fail } from "./companion-contract.mjs";

export async function requireX64Pe(path) {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(64);
    if (
      (await handle.read(header, 0, 64, 0)).bytesRead !== 64 ||
      header.toString("ascii", 0, 2) !== "MZ"
    )
      fail("PE_INVALID");
    const offset = header.readUInt32LE(60);
    const pe = Buffer.alloc(26);
    if (
      offset < 64 ||
      offset > 1024 * 1024 ||
      (await handle.read(pe, 0, 26, offset)).bytesRead !== 26 ||
      pe.readUInt32LE(0) !== 0x4550 ||
      pe.readUInt16LE(4) !== 0x8664 ||
      pe.readUInt16LE(24) !== 0x20b
    )
      fail("PE_INVALID");
  } finally {
    await handle.close();
  }
}
