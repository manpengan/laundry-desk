import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SampleOrder } from "../lib/variables.ts";
import { WASH_LABEL_VARS, STICKER_VARS } from "../lib/variables.ts";
import { buildXp58Receipt } from "./xp58-receipt.ts";
import {
  buildDl206WashLabel,
  buildDl206WashLabelEscI,
  listWashVarsRendered,
} from "./dl206-wash.ts";
import {
  buildGp3120Sticker,
  buildGp3120StickerCompact,
  listStickerVarsRendered,
} from "./gp3120-sticker.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "out");

function writeBin(name: string, buf: Buffer): void {
  const path = join(outDir, name);
  writeFileSync(path, buf);
  const hexPath = join(outDir, `${name}.hex.txt`);
  writeFileSync(hexPath, buf.toString("hex").match(/.{1,32}/g)?.join("\n") ?? "");
  console.log(`wrote ${name} (${buf.length} bytes)`);
}

function writeText(name: string, text: string): void {
  writeFileSync(join(outDir, name), text, "utf8");
  console.log(`wrote ${name}`);
}

function main(): void {
  mkdirSync(outDir, { recursive: true });
  const order = JSON.parse(
    readFileSync(join(root, "fixtures/sample-order.json"), "utf8"),
  ) as SampleOrder;

  writeBin("xp58-receipt.bin", buildXp58Receipt(order));
  writeBin("dl206-wash-fullvars.bin", buildDl206WashLabel(order));
  writeBin("dl206-wash-cut-esc-i.bin", buildDl206WashLabelEscI(order));
  writeBin("gp3120-sticker-fullvars.bin", buildGp3120Sticker(order));
  writeBin("gp3120-sticker-compact.bin", buildGp3120StickerCompact(order));

  writeText(
    "wash-vars-rendered.txt",
    [
      `# wash vars count=${WASH_LABEL_VARS.length} (matrix text said 21)`,
      ...listWashVarsRendered(order),
    ].join("\n"),
  );
  writeText(
    "sticker-vars-rendered.txt",
    [
      `# sticker vars count=${STICKER_VARS.length}`,
      ...listStickerVarsRendered(order),
    ].join("\n"),
  );

  writeText(
    "MANIFEST.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sampleTicket: order.ticketNo,
        files: [
          "xp58-receipt.bin",
          "dl206-wash-fullvars.bin",
          "dl206-wash-cut-esc-i.bin",
          "gp3120-sticker-fullvars.bin",
          "gp3120-sticker-compact.bin",
        ],
        washVarCount: WASH_LABEL_VARS.length,
        stickerVarCount: STICKER_VARS.length,
      },
      null,
      2,
    ),
  );
}

main();
