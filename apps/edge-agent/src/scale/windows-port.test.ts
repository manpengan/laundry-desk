import assert from "node:assert/strict";
import test from "node:test";
import { readWindowsScale } from "./windows-port.js";

test(
  "Windows native serial discovery returns only bounded COM identifiers without opening devices",
  {
    skip: process.platform !== "win32",
    timeout: 15000,
  },
  async () => {
    const value = await readWindowsScale({ operation: "ports" });
    assert.ok(value && typeof value === "object" && "ports" in value);
    assert.deepEqual(Object.keys(value), ["ports"]);
    assert.ok(Array.isArray(value.ports));
    assert.ok(value.ports.length <= 256);
    assert.ok(
      value.ports.every(
        (port: unknown) =>
          typeof port === "string" &&
          /^COM[1-9][0-9]{0,2}$/u.test(port) &&
          Number(port.slice(3)) <= 256,
      ),
    );
  },
);
