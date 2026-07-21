/**
 * Deterministic OpenAPI 3.1 snapshot writer for A7.
 * Run via: pnpm --filter @laundry/contracts generate:openapi
 * (builds dist/, then executes this file against compiled modules — no timestamps).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  OPENAPI_SNAPSHOT_RELATIVE_PATH,
  buildLaundryOpenApiDocument,
  serializeOpenApiDocument,
} from "../dist/openapi/build-document.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(packageRoot, OPENAPI_SNAPSHOT_RELATIVE_PATH);

const document = buildLaundryOpenApiDocument();
const text = serializeOpenApiDocument(document);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, text, "utf8");

// Stable console output only — never embed Date.now() or host paths in the snapshot.
process.stdout.write(`Wrote ${OPENAPI_SNAPSHOT_RELATIVE_PATH} (${text.length} bytes)\n`);
