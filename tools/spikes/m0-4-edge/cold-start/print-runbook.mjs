#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "electron-app");
const indexPath = join(root, "spa/index.html");
const hash = createHash("sha256").update(readFileSync(indexPath)).digest("hex");
const manifest = {
  version: "0.1.0-spike",
  indexSha256: hash,
  note: "Stand-in for signed SPA package; production uses detached signature + cert pin.",
};
writeFileSync(join(root, "spa/manifest.json"), JSON.stringify(manifest, null, 2));
console.log("updated spa/manifest.json");
console.log(hash);
console.log(`
Cold-start runbook
==================
1. cd tools/spikes/m0-4-edge/cold-start/electron-app
2. npm install
3. npm start
4. Confirm address bar / logs show app://local/... (not https://remote)
5. Click 探测 edgeBridge.ping() — expect { ok:true, data.mode: cold-start-spike }
6. Disconnect NIC / Wi-Fi, kill app, reboot machine (Windows field), start app offline
7. Page must still load; ping still works (local IPC only)

Security self-check (must all be true in main.mjs):
- nodeIntegration: false
- contextIsolation: true
- sandbox: true
- webSecurity: true
- setWindowOpenHandler deny
- will-navigate blocks non-app://
- permission handler default deny
- preload exposes only edgeBridge.ping
`);
