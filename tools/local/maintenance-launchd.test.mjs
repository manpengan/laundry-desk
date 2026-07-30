import assert from "node:assert/strict";
import test from "node:test";

import { buildMaintenancePlist, parseLaunchdArguments } from "./maintenance-launchd.mjs";

test("launchd maintenance schedule requires explicit install", () => {
  assert.equal(parseLaunchdArguments(["--install"]), undefined);
  assert.throws(() => parseLaunchdArguments([]), /LOCAL_MAINTENANCE_SCHEDULE_ARGS_INVALID/u);
});

test("launchd plist uses fixed daily arguments and escapes paths", () => {
  const plist = buildMaintenancePlist({
    nodePath: "/opt/node&runtime/bin/node",
    dockerPath: "/usr/local/bin/docker",
    scriptPath: "/workspace/tools/local/maintenance.mjs",
    cwd: "/workspace",
    logPath: "/private/logs/laundry.log",
  });
  assert.match(plist, /<integer>3<\/integer>/u);
  assert.match(plist, /--apply-retention/u);
  assert.match(plist, /node&amp;runtime/u);
  assert.match(
    plist,
    /<key>PATH<\/key><string>\/usr\/local\/bin:\/opt\/homebrew\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/u,
  );
  assert.doesNotMatch(plist, /password|token|secret/iu);
  assert.throws(
    () =>
      buildMaintenancePlist({
        nodePath: "node",
        dockerPath: "/usr/local/bin/docker",
        scriptPath: "/workspace/tools/local/maintenance.mjs",
        cwd: "/workspace",
        logPath: "/private/logs/laundry.log",
      }),
    /LOCAL_MAINTENANCE_SCHEDULE_PATH_INVALID/u,
  );
});
