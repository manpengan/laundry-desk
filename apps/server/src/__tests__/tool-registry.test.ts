import assert from "node:assert/strict";
import test from "node:test";

import {
  M1_FIRST_WAVE_DEFINITIONS,
  M2_READ_ONLY_AI_DEFINITIONS,
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

test("default projected names are a subset of the frozen M2 read-only catalog", () => {
  const catalogNames = new Set(M2_READ_ONLY_AI_DEFINITIONS.map((definition) => definition.name));
  const tools = listTools();
  assert.ok(tools.length > 0);
  for (const tool of tools) {
    assert.ok(catalogNames.has(tool.name), `unexpected tool ${tool.name}`);
  }

  // M2 projection never makes commands or platform settings available to the model.
  const names = new Set(listToolNames());
  assert.ok(names.has("order.list"));
  assert.ok(names.has("stats.day.summary"));
  assert.equal(names.has("identity.logout"), false);
  assert.equal(names.has("platform.settings.get"), false);
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
  const order = listTools().find((tool) => tool.name === "order.list");
  assert.ok(order);
  assert.equal(order.kind, "query");
  assert.ok(order.result_redaction.length > 0);
  assert.equal(typeof order.max_result_rows, "number");
  assert.ok(order.input_json_schema !== undefined);
  assert.equal(typeof order.description, "string");
  assert.ok(order.description.length > 0);
});

test("listTools supports preset whitelist and maxRisk filter", () => {
  const readonlyNames = listToolNames({ preset: "counter_readonly" });
  assert.ok(readonlyNames.includes("order.list"));
  assert.equal(readonlyNames.includes("platform.settings.get"), false);

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
