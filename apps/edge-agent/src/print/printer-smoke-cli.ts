/**
 * CLI: verify LAUNDRY_PRINTER_PATH without full Edge UI.
 *
 *   pnpm --filter @laundry/edge-agent printer-smoke
 *   pnpm --filter @laundry/edge-agent printer-smoke -- --validate
 *   LAUNDRY_PRINTER_PATH=/dev/usb/lp0 pnpm --filter @laundry/edge-agent printer-smoke
 *
 * Windows (PowerShell):
 *   $env:LAUNDRY_PRINTER_PATH = '\\.\COM3'
 *   pnpm --filter @laundry/edge-agent printer-smoke
 *
 * `--validate` checks configuration without opening or writing the device.
 * Exit 0 when ok; 1 when probe/validation fails. Prints JSON status only.
 */

import { runPrinterSmoke } from "./printer-smoke.js";

async function main(): Promise<number> {
  const validateOnly = process.argv.slice(2).includes("--validate");
  const timeoutRaw = process.env.LAUNDRY_PRINTER_SMOKE_TIMEOUT_MS;
  const timeoutMs =
    typeof timeoutRaw === "string" && timeoutRaw.trim().length > 0 ? Number(timeoutRaw) : undefined;
  const options = {
    ...(timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? { timeoutMs }
      : {}),
    ...(validateOnly ? { validateOnly: true as const } : {}),
  };

  const result = await runPrinterSmoke(process.env, options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      `${JSON.stringify({ ok: false, path: null, kind: "usb", message }, null, 2)}\n`,
    );
    process.exitCode = 1;
  });
