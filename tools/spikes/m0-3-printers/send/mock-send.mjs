#!/usr/bin/env node
/**
 * Mock spool: copy bins to out/mock-spool/ as if sent to printers.
 * Use when no COM/USB printer is attached.
 */
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "out");
const spool = join(outDir, "mock-spool");

const DEFAULTS = [
  "xp58-receipt.bin",
  "dl206-wash-fullvars.bin",
  "dl206-wash-cut-feed.bin",
  "gp3120-sticker-compact.bin",
];

function main() {
  mkdirSync(spool, { recursive: true });
  const files = process.argv.slice(2);
  const list = files.length > 0 ? files : DEFAULTS;
  const manifest = [];

  for (const name of list) {
    const src = join(outDir, name);
    const dest = join(spool, name);
    const buf = readFileSync(src);
    copyFileSync(src, dest);
    const sha = createHash("sha256").update(buf).digest("hex");
    manifest.push({
      file: name,
      bytes: buf.length,
      sha256: sha,
      mockTarget: `mock-spool/${name}`,
      note: "not sent to hardware",
    });
    console.log(`spooled ${name} (${buf.length} B) sha256=${sha.slice(0, 12)}…`);
  }

  const report = {
    at: new Date().toISOString(),
    environment: "no-printer-lab",
    jobs: manifest,
    remainingBins: readdirSync(outDir).filter((f) => f.endsWith(".bin")),
  };
  writeFileSync(join(spool, "MOCK-REPORT.json"), JSON.stringify(report, null, 2));
  console.log(`wrote ${join(spool, "MOCK-REPORT.json")}`);
  console.log("mock-send OK — attach printers later and use send-raw.mjs");
}

main();
