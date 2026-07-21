import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AUTH_OPERATION_MATRIX } from "../src/auth/operations.js";
import {
  M1_FIRST_WAVE_COMMAND_NAMES,
  M1_FIRST_WAVE_DEFINITIONS,
  M1_FIRST_WAVE_QUERY_NAMES,
} from "../src/commands/catalog.js";
import {
  OPENAPI_INFO_VERSION,
  OPENAPI_SNAPSHOT_RELATIVE_PATH,
  OPENAPI_VERSION,
  buildLaundryOpenApiDocument,
  serializeOpenApiDocument,
} from "../src/openapi/build-document.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotPath = join(packageRoot, OPENAPI_SNAPSHOT_RELATIVE_PATH);

const loadSnapshotText = (): string => readFileSync(snapshotPath, "utf8");

describe("A7 OpenAPI 3.1 snapshot", () => {
  it("builds a deterministic OpenAPI 3.1 document", () => {
    const first = serializeOpenApiDocument(buildLaundryOpenApiDocument());
    const second = serializeOpenApiDocument(buildLaundryOpenApiDocument());
    expect(first).toBe(second);
    expect(first.endsWith("\n")).toBe(true);

    const document = buildLaundryOpenApiDocument();
    expect(document.openapi).toBe(OPENAPI_VERSION);
    expect(document.openapi).toBe("3.1.0");
    expect(document.info.version).toBe(OPENAPI_INFO_VERSION);
    expect(document.info.title.length).toBeGreaterThan(0);
    expect(JSON.stringify(document)).not.toMatch(/T\d{2}:\d{2}:\d{2}/);
    expect(JSON.stringify(document)).not.toMatch(/generatedAt|timestamp|created_at/i);
  });

  it("projects AUTH_OPERATION_MATRIX paths and schema ids only", () => {
    const document = buildLaundryOpenApiDocument();
    const paths = Object.keys(document.paths).sort((left, right) => left.localeCompare(right));
    expect(paths).toEqual(paths.slice().sort((left, right) => left.localeCompare(right)));

    for (const row of AUTH_OPERATION_MATRIX) {
      const item = document.paths[row.path];
      expect(item, row.path).toBeDefined();
      expect(item?.post).toBeDefined();
      expect(item?.post?.operationId).toBe(`auth_${row.operation}`);
      expect(document.components.schemas[row.request_schema_id]).toBeDefined();
      expect(document.components.schemas[row.response_schema_id]).toBeDefined();
    }

    expect(AUTH_OPERATION_MATRIX).toHaveLength(5);
  });

  it("maps M1 first-wave commands and queries to stable bus paths", () => {
    const document = buildLaundryOpenApiDocument();

    for (const name of M1_FIRST_WAVE_COMMAND_NAMES) {
      const path = `/v1/commands/${name}`;
      expect(document.paths[path], path).toBeDefined();
      expect(document.paths[path]?.post?.operationId).toBe(`command_${name.replaceAll(".", "_")}`);
    }

    for (const name of M1_FIRST_WAVE_QUERY_NAMES) {
      const path = `/v1/queries/${name}`;
      expect(document.paths[path], path).toBeDefined();
      expect(document.paths[path]?.post?.operationId).toBe(`query_${name.replaceAll(".", "_")}`);
    }

    expect(M1_FIRST_WAVE_DEFINITIONS.length).toBe(
      M1_FIRST_WAVE_COMMAND_NAMES.length + M1_FIRST_WAVE_QUERY_NAMES.length,
    );
  });

  it("references the unified command error envelope components", () => {
    const document = buildLaundryOpenApiDocument();
    expect(document.components.schemas.CommandError).toBeDefined();
    expect(document.components.schemas.CommandFailureResponse).toBeDefined();
    expect(document.components.schemas.CommandResponse).toBeDefined();

    const login = document.paths["/api/v2/auth/login"]?.post;
    expect(login?.responses["200"]).toBeDefined();
    expect(JSON.stringify(login?.responses)).toContain("CommandFailureResponse");

    const bus = document.paths["/v1/commands/platform.settings.set"]?.post;
    expect(JSON.stringify(bus?.responses)).toContain("CommandResponse");
  });

  it("matches the committed snapshot exactly", () => {
    const generated = serializeOpenApiDocument(buildLaundryOpenApiDocument());
    const committed = loadSnapshotText();
    expect(generated).toBe(committed);
  });
});
