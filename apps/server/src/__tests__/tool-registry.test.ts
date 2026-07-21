import assert from "node:assert/strict";
import test from "node:test";

import {
  M1_FIRST_WAVE_COMMAND_NAMES,
  M1_FIRST_WAVE_DEFINITIONS,
  M1_FIRST_WAVE_QUERY_NAMES,
  isAiProjectableDefinition,
  platformSettingsSetCommand,
} from "@laundry/contracts";

import { listToolNames, listTools } from "../tools/list-tools.js";
import { projectCatalogToTools, stripRedactedExampleArgs } from "../tools/registry.js";

test("projection excludes R5 definitions (platform.settings.set)", () => {
  assert.equal(platformSettingsSetCommand.risk, "R5");
  assert.equal(isAiProjectableDefinition(platformSettingsSetCommand), false);

  const tools = projectCatalogToTools(M1_FIRST_WAVE_DEFINITIONS);
  assert.equal(
    tools.some((tool) => tool.name === "platform.settings.set"),
    false,
  );
  assert.equal(
    tools.some((tool) => tool.risk === "R5"),
    false,
  );
});

test("projection excludes secret-classified commands (login / pin_verify)", () => {
  const tools = projectCatalogToTools(M1_FIRST_WAVE_DEFINITIONS);
  const names = tools.map((tool) => tool.name);
  assert.equal(names.includes("identity.login"), false);
  assert.equal(names.includes("identity.pin_verify"), false);
  assert.equal(
    tools.some((tool) => tool.data_classification === "secret"),
    false,
  );
});

test("projected names are a subset of the M1 first-wave catalog", () => {
  const catalogNames = new Set<string>([
    ...M1_FIRST_WAVE_COMMAND_NAMES,
    ...M1_FIRST_WAVE_QUERY_NAMES,
  ]);
  const tools = listTools();
  assert.ok(tools.length > 0);
  for (const tool of tools) {
    assert.ok(catalogNames.has(tool.name), `unexpected tool ${tool.name}`);
  }

  // Known projectable subset from A6 first wave.
  const names = new Set(listToolNames());
  assert.ok(names.has("identity.logout"));
  assert.ok(names.has("identity.refresh"));
  assert.ok(names.has("identity.pin_challenge"));
  assert.ok(names.has("platform.settings.get"));
  assert.ok(names.has("platform.store_features.get"));
  assert.ok(names.has("platform.audit.list"));
});

test("secrets never appear in projected example args", () => {
  const stripped = stripRedactedExampleArgs(
    { username: "staff1", password: "not-a-real-password", pin: "1234" },
    [
      { path: "/password", strategy: "remove" },
      { path: "/pin", strategy: "remove" },
    ],
  );
  assert.deepEqual(stripped, { username: "staff1" });
  assert.equal(Object.hasOwn(stripped, "password"), false);
  assert.equal(Object.hasOwn(stripped, "pin"), false);

  for (const tool of listTools()) {
    const blob = JSON.stringify(tool.examples);
    assert.equal(/password|passwd|"pin"/iu.test(blob), false);
  }
});

test("descriptors carry redaction and limits fields", () => {
  const audit = listTools().find((tool) => tool.name === "platform.audit.list");
  assert.ok(audit);
  assert.equal(audit.kind, "query");
  assert.ok(audit.result_redaction.length > 0);
  assert.equal(typeof audit.max_result_rows, "number");
  assert.ok(audit.input_json_schema !== undefined);
  assert.equal(typeof audit.description, "string");
  assert.ok(audit.description.length > 0);
});

test("listTools supports preset whitelist and maxRisk filter", () => {
  const readonlyNames = listToolNames({ preset: "counter_readonly" });
  assert.ok(readonlyNames.includes("platform.settings.get"));
  assert.equal(readonlyNames.includes("platform.audit.list"), false);

  const deny = listToolNames({ preset: "deny_all" });
  assert.deepEqual(deny, []);

  const unknown = listToolNames({ preset: "no_such_preset" });
  assert.deepEqual(unknown, []);

  const r0Only = listToolNames({ maxRisk: "R0" });
  for (const name of r0Only) {
    const tool = listTools().find((entry) => entry.name === name);
    assert.ok(tool);
    assert.equal(tool.risk, "R0");
  }
});
