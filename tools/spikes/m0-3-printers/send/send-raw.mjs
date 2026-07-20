#!/usr/bin/env node
/**
 * Send a raw binary job to a printer path / COM port / TCP socket.
 *
 * Usage:
 *   node send/send-raw.mjs --file out/xp58-receipt.bin --target COM3
 *   node send/send-raw.mjs --file out/xp58-receipt.bin --target /dev/usb/lp0
 *   node send/send-raw.mjs --file out/gp3120-sticker-compact.bin --target 192.168.1.50:9100
 *   node send/send-raw.mjs --file out/xp58-receipt.bin --target "\\\\.\\COM3"
 */
import { readFileSync, writeFileSync, openSync, writeSync, closeSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";

function parseArgs(argv) {
  const out = { file: null, target: null, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--file") out.file = argv[++i];
    else if (a === "--target") out.target = argv[++i];
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function usage() {
  console.log(`send-raw.mjs --file <bin> --target <COM|path|host:port> [--dry-run]`);
}

function isTcp(target) {
  return /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(target) || target.includes(":") && !target.startsWith("\\\\");
}

async function sendTcp(host, port, buf) {
  await new Promise((resolvePromise, reject) => {
    const sock = connect({ host, port }, () => {
      sock.write(buf, (err) => {
        if (err) reject(err);
        else sock.end(() => resolvePromise());
      });
    });
    sock.on("error", reject);
  });
}

function sendFilePath(target, buf) {
  const fd = openSync(target, "w");
  try {
    writeSync(fd, buf);
  } finally {
    closeSync(fd);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.file || !args.target) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const file = resolve(args.file);
  const buf = readFileSync(file);
  console.log(`file=${file} bytes=${buf.length} target=${args.target}`);

  if (args.dryRun) {
    const dump = resolve(`${file}.dry-run.hex`);
    writeFileSync(dump, buf.toString("hex"));
    console.log(`dry-run wrote ${dump}`);
    return;
  }

  if (isTcp(args.target) && !args.target.startsWith("\\\\")) {
    const [host, portStr] = args.target.split(":");
    await sendTcp(host, Number(portStr), buf);
    console.log("tcp send ok");
    return;
  }

  // Windows COM / USB raw device path / Linux lp
  sendFilePath(args.target, buf);
  console.log("path send ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
