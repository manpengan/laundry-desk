/**
 * Offline verification when no physical printers are available.
 * Inspects generated bins for protocol markers + GBK yuan sign + no 0x3F.
 *
 * Usage: npm run generate && npm run verify
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "out");

type Check = { name: string; ok: boolean; detail: string };

function check(name: string, ok: boolean, detail: string): Check {
  return { name, ok, detail };
}

function mustExist(file: string): Buffer {
  const path = join(outDir, file);
  if (!existsSync(path)) {
    throw new Error(`missing ${file} — run npm run generate first`);
  }
  return readFileSync(path);
}

function hasSeq(buf: Buffer, seq: number[]): boolean {
  return buf.includes(Buffer.from(seq));
}

function gbkPreview(buf: Buffer, max = 200): string {
  // Best-effort: decode whole buffer as GBK and strip controls for human scan.
  const text = iconv.decode(buf, "gbk").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "·");
  return text.slice(0, max).replace(/\s+/g, " ").trim();
}

function verifyXp58(buf: Buffer): Check[] {
  return [
    check("xp58-init", buf[0] === 0x1b && buf[1] === 0x40, "ESC @"),
    check("xp58-code128-set", hasSeq(buf, [0x7b, 0x42]) || hasSeq(buf, [0x7b, 0x43]), "{B or {C"),
    check("xp58-gs-k", hasSeq(buf, [0x1d, 0x6b, 73]), "GS k 73"),
    check("xp58-yuan-gbk", hasSeq(buf, [0xa3, 0xa4]), "￥ = A3 A4"),
    check("xp58-no-qmark", !buf.includes(0x3f), "no 0x3F"),
    check("xp58-cut", hasSeq(buf, [0x1d, 0x56]), "GS V"),
  ];
}

function verifyDl206(buf: Buffer, mode: "full" | "esc-i" | "feed"): Check[] {
  const base = [
    check(`dl206-${mode}-yuan`, hasSeq(buf, [0xa3, 0xa4]), "￥"),
    check(`dl206-${mode}-no-qmark`, !buf.includes(0x3f), "no 0x3F"),
  ];
  if (mode === "full") {
    base.push(check("dl206-full-cut", hasSeq(buf, [0x1d, 0x56, 0x00]), "GS V 0"));
  } else if (mode === "esc-i") {
    base.push(check("dl206-esc-i", hasSeq(buf, [0x1b, 0x69]), "ESC i"));
  } else {
    base.push(check("dl206-feed-cut", hasSeq(buf, [0x1d, 0x56, 66, 3]), "GS V 66 3"));
  }
  return base;
}

function verifyGp3120(buf: Buffer, full: boolean): Check[] {
  const text = buf.toString("latin1");
  const tag = full ? "full" : "compact";
  return [
    check(`gp-${tag}-size`, text.includes("SIZE 40 mm"), "SIZE 40 mm"),
    check(
      `gp-${tag}-height`,
      full ? text.includes("90 mm") : text.includes("30 mm"),
      full ? "90 mm fullvars" : "30 mm compact",
    ),
    check(`gp-${tag}-barcode`, text.includes("BARCODE "), "BARCODE"),
    check(`gp-${tag}-print`, text.includes("PRINT "), "PRINT"),
    // compact also prints 单价 with fullwidth ￥ for GBK regression coverage
    check(`gp-${tag}-yuan`, hasSeq(buf, [0xa3, 0xa4]), "￥ GBK in TEXT"),
    check(`gp-${tag}-no-qmark`, !buf.includes(0x3f), "no 0x3F"),
  ];
}

function main(): void {
  console.log("=== M0-3 offline verify (no printer required) ===");
  console.log(`outDir=${outDir}`);
  if (!existsSync(outDir)) {
    console.error("out/ missing — run: npm run generate");
    process.exit(1);
  }

  const checks: Check[] = [
    ...verifyXp58(mustExist("xp58-receipt.bin")),
    ...verifyDl206(mustExist("dl206-wash-fullvars.bin"), "full"),
    ...verifyDl206(mustExist("dl206-wash-cut-esc-i.bin"), "esc-i"),
    ...verifyDl206(mustExist("dl206-wash-cut-feed.bin"), "feed"),
    ...verifyGp3120(mustExist("gp3120-sticker-fullvars.bin"), true),
    ...verifyGp3120(mustExist("gp3120-sticker-compact.bin"), false),
  ];

  // Boundary samples exist
  for (const tag of ["empty", "long", "special"]) {
    for (const kind of ["xp58", "dl206", "gp3120"]) {
      const name = `boundary-${tag}-${kind}.bin`;
      const ok = existsSync(join(outDir, name));
      checks.push(check(`exists-${name}`, ok, ok ? "present" : "MISSING"));
    }
  }

  let failed = 0;
  for (const c of checks) {
    const mark = c.ok ? "OK " : "FAIL";
    if (!c.ok) failed += 1;
    console.log(`${mark}  ${c.name}: ${c.detail}`);
  }

  console.log("\n--- GBK preview (xp58 first ~200 printable chars) ---");
  console.log(gbkPreview(mustExist("xp58-receipt.bin")));
  console.log("\n--- files in out/ ---");
  console.log(
    readdirSync(outDir)
      .filter((f) => f.endsWith(".bin"))
      .sort()
      .join("\n"),
  );

  console.log(
    `\n=== result: ${failed === 0 ? "PASS" : "FAIL"} (${checks.length - failed}/${checks.length}) ===`,
  );
  console.log(
    "NOTE: No physical printer in lab. Hardware acceptance deferred to field day.",
  );
  process.exit(failed === 0 ? 0 : 1);
}

main();
