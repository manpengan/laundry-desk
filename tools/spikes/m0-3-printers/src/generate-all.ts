import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SampleOrder } from "../lib/variables.ts";
import { WASH_LABEL_VARS, STICKER_VARS } from "../lib/variables.ts";
import {
  emptyVarsOrder,
  longTextOrder,
  specialCharsOrder,
} from "../lib/boundary.ts";
import {
  encodeCode128Payload,
  estimateCode128Dots,
  XP58_PRINTABLE_DOTS,
} from "../lib/escpos.ts";
import {
  buildXp58Receipt,
  buildXp58ReceiptVariant,
  XP58_BARCODE_VARIANTS,
} from "./xp58-receipt.ts";
import {
  buildDl206WashLabel,
  buildDl206WashLabelEscI,
  buildDl206WashLabelFeedCut,
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
  writeFileSync(
    hexPath,
    buf.toString("hex").match(/.{1,32}/g)?.join("\n") ?? "",
  );
  console.log(`wrote ${name} (${buf.length} bytes)`);
}

function writeText(name: string, text: string): void {
  writeFileSync(join(outDir, name), text, "utf8");
  console.log(`wrote ${name}`);
}

function loadSample(): SampleOrder {
  return JSON.parse(
    readFileSync(join(root, "fixtures/sample-order.json"), "utf8"),
  ) as SampleOrder;
}

function main(): void {
  mkdirSync(outDir, { recursive: true });
  const order = loadSample();
  const files: string[] = [];

  const defaultReceipt = buildXp58Receipt(order);
  writeBin("xp58-receipt.bin", defaultReceipt);
  files.push("xp58-receipt.bin");

  for (const variant of XP58_BARCODE_VARIANTS) {
    const name = `xp58-receipt-${variant.label}.bin`;
    writeBin(name, buildXp58ReceiptVariant(order, variant));
    files.push(name);
  }

  writeBin("dl206-wash-fullvars.bin", buildDl206WashLabel(order));
  writeBin("dl206-wash-cut-esc-i.bin", buildDl206WashLabelEscI(order));
  writeBin("dl206-wash-cut-feed.bin", buildDl206WashLabelFeedCut(order));
  writeBin("gp3120-sticker-fullvars.bin", buildGp3120Sticker(order));
  writeBin("gp3120-sticker-compact.bin", buildGp3120StickerCompact(order));
  files.push(
    "dl206-wash-fullvars.bin",
    "dl206-wash-cut-esc-i.bin",
    "dl206-wash-cut-feed.bin",
    "gp3120-sticker-fullvars.bin",
    "gp3120-sticker-compact.bin",
  );

  const boundaries: Array<[string, SampleOrder]> = [
    ["empty", emptyVarsOrder()],
    ["long", longTextOrder()],
    ["special", specialCharsOrder()],
  ];
  for (const [tag, sample] of boundaries) {
    const names = [
      [`boundary-${tag}-xp58.bin`, buildXp58Receipt(sample)],
      [`boundary-${tag}-dl206.bin`, buildDl206WashLabel(sample)],
      [`boundary-${tag}-gp3120.bin`, buildGp3120StickerCompact(sample)],
    ] as const;
    for (const [name, buf] of names) {
      writeBin(name, buf);
      files.push(name);
    }
  }

  const payloadBc = encodeCode128Payload(order.barcode, "BC");
  const payloadB = encodeCode128Payload(order.barcode, "B");
  writeText(
    "code128-width-plan.txt",
    [
      `# barcode=${order.barcode}`,
      `# XP-58 printable dots ≈ ${XP58_PRINTABLE_DOTS}`,
      `# estimate = (11*symbols + 55) * moduleWidth; {B/{C count as 1 symbol each`,
      `BC payload=${payloadBc.toString("ascii")} est@w1=${estimateCode128Dots(payloadBc, 1)} est@w2=${estimateCode128Dots(payloadBc, 2)}`,
      `B  payload=${payloadB.toString("ascii")} est@w1=${estimateCode128Dots(payloadB, 1)} est@w2=${estimateCode128Dots(payloadB, 2)}`,
      `# Pure B @ GS w 2 exceeds 384 → will clip; prefer BC+w1 or B+w1`,
    ].join("\n"),
  );

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
        files,
        washVarCount: WASH_LABEL_VARS.length,
        stickerVarCount: STICKER_VARS.length,
        xp58BarcodeDefault: { mode: "BC", moduleWidth: 1 },
        xp58BarcodeVariants: XP58_BARCODE_VARIANTS.map((v) => v.label),
        gp3120FullvarsSizeMm: [40, 90],
      },
      null,
      2,
    ),
  );
}

main();
