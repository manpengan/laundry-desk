import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { launchCommander, storeAcceptanceFailure } from "./lifecycle-acceptance-command.mjs";
import { syntheticStoreInput } from "./store-initialization-acceptance.mjs";

function fixture(reply) {
  const launches = [],
    logs = [];
  const execute = (file, args, options) => {
    const stdin = new PassThrough(),
      stderr = new PassThrough();
    const chunks = [];
    stdin.on("data", (bytes) => chunks.push(Buffer.from(bytes)));
    const pending = new Promise((resolve, reject) => {
      stdin.on("end", () => {
        const input = Buffer.concat(chunks).toString("utf8");
        launches.push({ file, args, options, input });
        const result = reply(input);
        if (result.inputError) stdin.emit("error", new Error("SYNTHETIC_INPUT_FAILED"));
        if (result.stderr) stderr.write(result.stderr);
        stderr.end();
        if (result.failure) reject(Object.assign(new Error("SYNTHETIC_CHILD_FAILED"), result));
        else resolve(result);
      });
    });
    pending.child = { stdin, stderr };
    return pending;
  };
  const command = launchCommander(
    {
      payload: "C:\\synthetic-payload",
      expectedDigest: "a".repeat(64),
      env: { SystemRoot: "C:\\Windows" },
    },
    { execute, log: (line) => logs.push(line) },
  );
  return { command, launches, logs };
}

test("operator acceptance sends the two random identities only through inherited stdin", async () => {
  const input = syntheticStoreInput();
  const test = fixture(() => ({
    stdout: JSON.stringify({ status: "running", assurance: "development_only" }),
    stderr: 'WINDOWS_COMPANION_TIMING {"executable":"node.exe","elapsed_ms":12}\n',
  }));
  assert.equal(
    (await test.command("install-store", undefined, undefined, input)).status,
    "running",
  );
  assert.equal(JSON.stringify(JSON.parse(test.launches[0].input)) === JSON.stringify(input), true);
  for (const value of [...Object.values(input.admin), ...Object.values(input.approver)]) {
    assert.equal(JSON.stringify(test.launches[0].args).includes(value), false);
    assert.equal(JSON.stringify(test.launches[0].options).includes(value), false);
    assert.equal(JSON.stringify(test.logs).includes(value), false);
  }
  assert.equal(test.logs.length, 2);
});

for (const channel of ["stdout", "stderr", "failed-stderr", "timing"]) {
  test(`operator acceptance detects ${channel} credential echoes without publishing the value`, async () => {
    const input = syntheticStoreInput();
    const test = fixture(() => ({
      stdout: channel === "stdout" ? JSON.stringify({ password: input.admin.password }) : "{}",
      stderr:
        channel === "timing"
          ? `WINDOWS_COMPANION_TIMING ${JSON.stringify({ executable: "node.exe", elapsed_ms: Number(input.admin.pin) })}\n`
          : channel.includes("stderr")
            ? input.approver.password
            : "",
      failure: channel === "failed-stderr",
    }));
    await assert.rejects(test.command("install-store", undefined, undefined, input), {
      message: "WINDOWS_COMPANION_STORE_ACCEPTANCE_SECRET_OUTPUT",
    });
    for (const value of [...Object.values(input.admin), ...Object.values(input.approver)])
      assert.equal(JSON.stringify(test.logs).includes(value), false);
  });
}

test("timing output is reconstructed from fixed fields; malformed or extra fields cannot reach logs", async () => {
  const test = fixture(() => ({
    stdout: "{}",
    stderr: [
      'WINDOWS_COMPANION_TIMING {"executable":"node.exe","elapsed_ms":2,"private":"do-not-print"}',
      'WINDOWS_COMPANION_TIMING {"executable":["node.exe"],"elapsed_ms":2}',
      'WINDOWS_COMPANION_TIMING {"executable":"do-not-print","elapsed_ms":2}',
      'WINDOWS_COMPANION_TIMING {"executable":"psql.exe","elapsed_ms":2}',
      "raw-private-error-do-not-print",
      "",
    ].join("\n"),
  }));
  await test.command("status");
  assert.equal(test.logs.length, 2);
  assert.equal(test.logs[0], 'WINDOWS_COMPANION_TIMING {"executable":"psql.exe","elapsed_ms":2}');
  assert.equal(
    test.logs.some((line) => line.includes("do-not-print")),
    false,
  );
});

test("existing-store refusal retains its stable code for the negative acceptance assertion", async () => {
  const test = fixture(() => ({
    failure: true,
    stdout: "",
    stderr: "WINDOWS_COMPANION_STORE_REQUIRES_NEW_INSTANCE\n",
  }));
  await assert.rejects(
    test.command("install-store", undefined, undefined, syntheticStoreInput()),
    (error) => error.stderr.trim() === "WINDOWS_COMPANION_STORE_REQUIRES_NEW_INSTANCE",
  );
});

test("stdin transport failure cannot be reported as successful initialization", async () => {
  const input = syntheticStoreInput();
  const test = fixture(() => ({ inputError: true, stdout: '{"status":"running"}' }));
  await assert.rejects(test.command("install-store", undefined, undefined, input), {
    message: "WINDOWS_COMPANION_ACCEPTANCE_INPUT_FAILED",
  });
  for (const value of [...Object.values(input.admin), ...Object.values(input.approver)])
    assert.equal(JSON.stringify(test.logs).includes(value), false);
});

test("failed initialization preserves only bounded public producer diagnostics and the primary code", () => {
  const js = {
    code: "ENOENT",
    cause_code: null,
    message_code: null,
    frames: ["lifecycle-release.mjs:78:4"],
  };
  const native = {
    code: "PathNotFound,Microsoft.PowerShell.Commands.GetItemCommand",
    frames: ["lifecycle-host.ps1:115"],
  };
  const original = Object.assign(new Error("Command failed: C:\\private-user\\runtime.ps1"), {
    stdout: "private-output",
    stderr: [
      "unstructured-private-message",
      `WINDOWS_COMPANION_DIAGNOSTIC ${JSON.stringify(native)}`,
      `WINDOWS_COMPANION_DIAGNOSTIC ${JSON.stringify(js)}`,
      "WINDOWS_COMPANION_RELEASE_STAGE_FAILED",
      "",
    ].join("\n"),
  });
  const result = storeAcceptanceFailure(original);
  assert.equal(result.message, "WINDOWS_COMPANION_RELEASE_STAGE_FAILED");
  assert.equal(result.cause, undefined);
  assert.equal(result.stdout, undefined);
  assert.equal(
    result.stderr,
    [
      `WINDOWS_COMPANION_DIAGNOSTIC ${JSON.stringify(native)}`,
      `WINDOWS_COMPANION_DIAGNOSTIC ${JSON.stringify(js)}`,
      result.message,
    ].join("\n"),
  );
  assert.equal(JSON.stringify(result).includes("private"), false);
  const primary = storeAcceptanceFailure({
    ...original,
    message: "WINDOWS_COMPANION_PRIMARY_FAILED",
  });
  assert.equal(primary.message, "WINDOWS_COMPANION_PRIMARY_FAILED");
});

test("diagnostic rejection excludes unknown fields, arbitrary text, absolute frames and oversized records", () => {
  const valid = {
    code: "ENOENT",
    cause_code: null,
    message_code: null,
    frames: ["lifecycle.mjs:1:2"],
  };
  const rejected = [
    null,
    [],
    { ...valid, private: "must-not-publish" },
    { ...valid, code: "arbitrary private message" },
    { ...valid, cause_code: { message: "private" } },
    { ...valid, frames: ["C:\\private-user\\lifecycle.mjs:1:2"] },
    { ...valid, frames: ["/private-user/lifecycle.mjs:1:2"] },
    { ...valid, frames: ["other-module.mjs:1:2"] },
    { ...valid, frames: Array(6).fill("lifecycle.mjs:1:2") },
    { code: "E".repeat(121), frames: ["lifecycle-host.ps1:1"] },
    { ...valid, code: "E".repeat(2050) },
  ];
  const lines = rejected.map((value) => `WINDOWS_COMPANION_DIAGNOSTIC ${JSON.stringify(value)}`);
  lines.push("WINDOWS_COMPANION_DIAGNOSTIC {invalid-json}");
  const result = storeAcceptanceFailure({ message: "raw-private", stderr: lines.join("\n") });
  assert.equal(result.stderr, "WINDOWS_COMPANION_STORE_ACCEPTANCE_FAILED");
  assert.equal(storeAcceptanceFailure({ stderr: "x".repeat(65537) }).stderr, result.stderr);
  const many = Array(20)
    .fill(`WINDOWS_COMPANION_DIAGNOSTIC ${JSON.stringify(valid)}`)
    .join("\n");
  assert.equal(storeAcceptanceFailure({ stderr: many }).stderr.split("\n").length, 9);
});

test("raw and JSON-escaped input secrets never enter reconstructed diagnostics", () => {
  const secret = "qa-private-owner";
  for (const value of [
    { message: secret },
    { stdout: secret },
    { stderr: secret },
    { stderr: 'WINDOWS_COMPANION_DIAGNOSTIC {"code":"qa-\\u0070rivate-owner","frames":[]}' },
  ]) {
    assert.throws(() => storeAcceptanceFailure(value, [secret]), {
      message: "WINDOWS_COMPANION_STORE_ACCEPTANCE_SECRET_OUTPUT",
    });
  }
});
