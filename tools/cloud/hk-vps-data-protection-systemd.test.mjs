import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { REMOTE_RELEASE_LOCK } from "./hk-vps-release-core.mjs";

const ROOT = new URL("./systemd/", import.meta.url);
const ACTIONS = Object.freeze(["backup", "offsite", "drill", "status"]);

test("scheduled data protection services are root-only, hardened and share the release lock", async () => {
  for (const action of ACTIONS) {
    const source = await readFile(new URL(`laundry-desk-data-${action}.service`, ROOT), "utf8");
    assert.match(source, /^User=root$/mu);
    assert.match(source, /^Group=root$/mu);
    assert.match(source, /^UMask=0077$/mu);
    assert.match(source, /^NoNewPrivileges=yes$/mu);
    assert.match(source, /^ProtectSystem=strict$/mu);
    assert.match(source, /^ProtectProc=invisible$/mu);
    assert.match(source, /^ProtectKernelTunables=yes$/mu);
    assert.match(source, /^PrivateDevices=yes$/mu);
    assert.match(source, /^TimeoutStartSec=(?:10|30)min$/mu);
    assert.ok(
      source.includes(
        `/usr/bin/flock --no-fork --exclusive --nonblock --conflict-exit-code 73 ${REMOTE_RELEASE_LOCK}`,
      ),
    );
    assert.ok(source.includes(" --lock-held "));
  }
});

test("data protection timers are persistent and keep fixed bounded schedules", async () => {
  const expectations = new Map([
    ["backup", "OnCalendar=*-*-* 02:15:00"],
    ["offsite", "OnCalendar=*-*-* 04:15:00"],
    ["drill", "OnCalendar=Sun *-*-* 05:15:00"],
    ["status", "OnUnitActiveSec=15m"],
  ]);
  for (const [action, schedule] of expectations) {
    const source = await readFile(new URL(`laundry-desk-data-${action}.timer`, ROOT), "utf8");
    assert.match(source, /^Persistent=true$/mu);
    assert.ok(source.includes(schedule));
    assert.ok(source.includes(`Unit=laundry-desk-data-${action}.service`));
  }
});
