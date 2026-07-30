import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  createMacPrinterAcceptanceRecord,
  writeMacPrinterAcceptanceRecord,
  type MacPrinterOperatorConfirmation,
} from "./mac-printer-acceptance.js";
import { runMacPrinterPilot } from "./mac-printer-pilot.js";

function parseQueue(argv: readonly string[]): string {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  if (args.length !== 2 || args[0] !== "--cups-queue" || args[1] === undefined) {
    throw new Error("use --cups-queue <installed-name>");
  }
  return args[1];
}

async function askForConfirmation(): Promise<MacPrinterOperatorConfirmation> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error("physical acceptance requires an interactive terminal");
  }
  const prompts = [
    ["text_clear", "文字和金额清晰"],
    ["feed_ok", "走纸长度正常"],
    ["cut_or_tear_ok", "切刀或撕纸位置正常"],
    ["barcode_scanned", "条码已被扫描器成功回读"],
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
  const queue = parseQueue(process.argv.slice(2));
  const pilot = await runMacPrinterPilot({ mode: "print", queue });
  process.stdout.write(`${JSON.stringify(pilot, null, 2)}\n`);
  if (!pilot.ok) throw new Error("physical print submission failed");
  const confirmation = await askForConfirmation();
  const record = createMacPrinterAcceptanceRecord(pilot, confirmation, await loadVersion());
  const directory = join(
    homedir(),
    "Library",
    "Application Support",
    "laundry-desk V2",
    "hardware-acceptance",
  );
  const path = await writeMacPrinterAcceptanceRecord(directory, record);
  process.stdout.write(`${JSON.stringify({ ok: true, record: path })}\n`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "printer acceptance failed";
  process.stderr.write(`[printer-acceptance] ${message}\n`);
  process.exitCode = 1;
});
