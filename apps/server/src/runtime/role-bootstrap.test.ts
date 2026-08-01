import assert from "node:assert/strict";
import test from "node:test";

import { applyRuntimeRoles, type RuntimeRoleClient } from "./role-bootstrap.js";

test("role bootstrap parameterizes the app password and executes only server-formatted DDL", async () => {
  const password = "app-password-sentinel-is-over-thirty-two-bytes";
  const calls: Array<Readonly<{ text: string; values?: readonly unknown[] }>> = [];
  const client: RuntimeRoleClient = Object.freeze({
    query: async (text: string, values?: readonly unknown[]) => {
      calls.push(Object.freeze({ text, ...(values === undefined ? {} : { values }) }));
      if (text.includes("pg_catalog.format")) {
        return Object.freeze({
          rows: [{ statement: "ALTER ROLE laundry_app PASSWORD 'redacted'" }],
        });
      }
      return Object.freeze({ rows: [] });
    },
  });

  await applyRuntimeRoles(client, password);

  const parameterized = calls.find((call) => call.text.includes("pg_catalog.format"));
  assert.deepEqual(parameterized?.values, [password]);
  assert.equal(
    calls.some((call) => call.text.includes(password)),
    false,
  );
  assert.equal(
    calls.some((call) => call.text === "ALTER ROLE laundry_app PASSWORD 'redacted'"),
    true,
  );
  assert.equal(calls.at(0)?.text, "BEGIN");
  assert.equal(calls.at(-1)?.text, "COMMIT");
});

test("role bootstrap rolls back and never includes a password in errors", async () => {
  const calls: string[] = [];
  const client: RuntimeRoleClient = Object.freeze({
    query: async (text: string) => {
      calls.push(text);
      if (text.includes("CREATE ROLE laundry_owner")) throw new Error("database sentinel");
      return Object.freeze({ rows: [] });
    },
  });

  await assert.rejects(
    () => applyRuntimeRoles(client, "private-password-is-over-thirty-two-bytes"),
    /database sentinel/u,
  );
  assert.equal(calls.at(-1), "ROLLBACK");
});
