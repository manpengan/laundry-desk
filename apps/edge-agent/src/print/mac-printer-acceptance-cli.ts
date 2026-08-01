import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  createMacPrinterAcceptanceRecord,
  loadSignedPrintAcceptanceEvidence,
  writeMacPrinterAcceptanceRecord,
  type MacPrinterOperatorConfirmation,
} from "./mac-printer-acceptance.js";

function parseJobId(argv: readonly string[]): string {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  if (args.length !== 2 || args[0] !== "--job-id" || args[1] === undefined) {
    throw new Error("use --job-id <uploaded-signed-dispatch-uuid>");
  }
  return args[1];
}

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

async function loadVersion(): Promise<string> {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const parsed = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof parsed.version !== "string") throw new Error("package version is unavailable");
  return parsed.version;
}

async function main(): Promise<void> {
  const jobId = parseJobId(process.argv.slice(2));
  const applicationRoot = join(homedir(), "Library", "Application Support", "laundry-desk V2");
  const evidence = await loadSignedPrintAcceptanceEvidence(
    join(applicationRoot, "edge-state", "print-dispatch"),
    jobId,
  );
  const confirmation = await askForConfirmation();
  const record = createMacPrinterAcceptanceRecord(evidence, confirmation, await loadVersion());
  const directory = join(applicationRoot, "hardware-acceptance");
  const path = await writeMacPrinterAcceptanceRecord(directory, record);
  process.stdout.write(`${JSON.stringify({ ok: true, record: path })}\n`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "printer acceptance failed";
  process.stderr.write(`[printer-acceptance] ${message}\n`);
  process.exitCode = 1;
});
