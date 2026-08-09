import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  createMacPrinterAcceptanceRecord,
  loadMacPrinterAcceptanceEvidence,
  writeMacPrinterAcceptanceRecord,
  type MacPrinterOperatorConfirmation,
} from "./mac-printer-acceptance.js";
import { hashPackagedMacApp } from "./mac-printer-acceptance-artifacts.js";
import { parseMacPrinterAcceptanceArgs } from "./mac-printer-acceptance-cli-args.js";

async function askForConfirmation(): Promise<MacPrinterOperatorConfirmation> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error("physical acceptance requires an interactive terminal");
  }
  const prompts = [
    ["chinese_clear", "中文文字清晰可辨"],
    ["amounts_correct", "金额与真实订单一致"],
    ["feed_ok", "走纸长度正常"],
    ["cut_or_tear_ok", "切刀或撕纸位置正常"],
    ["barcode_scanned", "条码已被扫描器成功回读"],
    ["disconnect_no_duplicate", "断开打印机测试未产生重复票据"],
    ["explicit_reprint_one_copy", "显式重打测试只产生一份票据"],
  ] as const;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const entries: Array<readonly [string, boolean]> = [];
    for (const [key, label] of prompts) {
      const answer = await terminal.question(`${label}，输入 YES 确认：`);
      entries.push([key, answer.trim() === "YES"]);
    }
    return Object.freeze(Object.fromEntries(entries)) as MacPrinterOperatorConfirmation;
  } finally {
    terminal.close();
  }
}

async function main(): Promise<void> {
  const args = parseMacPrinterAcceptanceArgs(process.argv.slice(2));
  const applicationRoot = join(homedir(), "Library", "Application Support", "laundry-desk V2");
  const evidence = await loadMacPrinterAcceptanceEvidence(
    join(applicationRoot, "edge-state", "print-dispatch"),
    {
      original: args.originalJobId,
      disconnect: args.disconnectJobId,
      reprint: args.reprintJobId,
    },
  );
  const packagedApp = await hashPackagedMacApp(args.appPath);
  const confirmation = await askForConfirmation();
  const record = createMacPrinterAcceptanceRecord(evidence, confirmation, {
    printerModel: args.printerModel,
    connection: args.connection,
    packagedApp,
  });
  const directory = join(applicationRoot, "hardware-acceptance");
  const path = await writeMacPrinterAcceptanceRecord(directory, record);
  process.stdout.write(`${JSON.stringify({ ok: true, record: path })}\n`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "printer acceptance failed";
  process.stderr.write(`[printer-acceptance] ${message}\n`);
  process.exitCode = 1;
});
