import { runMacPrinterPilot } from "./mac-printer-pilot.js";

function parseArgs(argv: readonly string[]) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  if (args.length === 1 && args[0] === "--discover") {
    return Object.freeze({ mode: "discover" as const });
  }
  if (
    args.length === 3 &&
    args[0] === "--cups-queue" &&
    typeof args[1] === "string" &&
    (args[2] === "--validate" || args[2] === "--print")
  ) {
    return Object.freeze({
      mode: args[2] === "--print" ? ("print" as const) : ("validate" as const),
      queue: args[1],
    });
  }
  throw new Error("MAC_PRINTER_PILOT_ARGS_INVALID");
}

async function main(): Promise<number> {
  let input;
  try {
    input = parseArgs(process.argv.slice(2));
  } catch {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        message: "Use --discover or --cups-queue <installed-name> --validate|--print",
      })}\n`,
    );
    return 1;
  }
  const result = await runMacPrinterPilot(input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

void main().then((code) => {
  process.exitCode = code;
});
