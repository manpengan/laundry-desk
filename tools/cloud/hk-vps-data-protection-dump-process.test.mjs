import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  dataProtectionDumpArguments,
  runDataProtectionDumpProcess,
} from "./hk-vps-data-protection-dump-process.mjs";

test("pg_dump writes through a root-opened descriptor instead of traversing the private set", async (t) => {
  const path = join(tmpdir(), `laundry-data-dump-${process.pid}-${Date.now()}`);
  t.after(async () => await rm(path, { force: true }));
  const handle = await open(path, "wx", 0o600);
  t.after(async () => await handle.close().catch(() => undefined));
  let invocation;
  await runDataProtectionDumpProcess(handle, undefined, {
    spawn: (file, arguments_, options) => {
      invocation = { file, arguments_, options };
      const child = new EventEmitter();
      child.pid = 0;
      child.stderr = new PassThrough();
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
  });
  assert.equal(invocation.file, "/usr/bin/sudo");
  assert.deepEqual(invocation.arguments_, dataProtectionDumpArguments());
  assert.equal(invocation.options.stdio[1], handle.fd);
  assert.equal(
    invocation.arguments_.some((value) => value.startsWith("--file=")),
    false,
  );
});
