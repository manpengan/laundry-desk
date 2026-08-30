import { PrinterQueueNameSchema } from "@laundry/contracts";
import { z } from "zod";

import { DurableJsonFile } from "./durable-json-file.js";

const MAX_CONFIG_BYTES = 1_024;

export const PrinterConfigSchema = z.strictObject({
  version: z.literal(1),
  queue: PrinterQueueNameSchema.nullable(),
});

export type PrinterConfig = Readonly<z.output<typeof PrinterConfigSchema>>;

export const DISABLED_PRINTER_CONFIG: PrinterConfig = Object.freeze({
  version: 1,
  queue: null,
});

function parseConfig(input: unknown): PrinterConfig {
  const parsed = PrinterConfigSchema.parse(input);
  return Object.freeze({ version: parsed.version, queue: parsed.queue });
}

/** Device-local, private and atomically replaced OS queue selection. */
export class PrinterConfigStore {
  private constructor(private readonly file: DurableJsonFile<PrinterConfig>) {}

  static async open(
    rootPath: string,
    options: Readonly<{ randomStagingId?: () => string }> = {},
  ): Promise<PrinterConfigStore> {
    const file = await DurableJsonFile.open({
      rootPath,
      fileName: "printer-config.json",
      maxBytes: MAX_CONFIG_BYTES,
      parse: parseConfig,
      ...(options.randomStagingId === undefined
        ? {}
        : { randomStagingId: options.randomStagingId }),
    });
    return new PrinterConfigStore(file);
  }

  read(): Promise<PrinterConfig | null> {
    return this.file.read();
  }

  write(config: PrinterConfig): Promise<void> {
    return this.file.write(parseConfig(config));
  }
}
