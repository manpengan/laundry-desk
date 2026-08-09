import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hashPackagedMacApp } from "./mac-printer-acceptance-artifacts.js";

type AppFixture = Readonly<{
  app: string;
  appAsar: string;
  spaManifest: string;
  infoPlist: string;
}>;

type InfoPlistOptions = Readonly<{
  identifier?: string;
  shortVersion?: string;
  bundleVersion?: string;
}>;

function infoPlist(options: InfoPlistOptions = {}): string {
  const identifier = options.identifier ?? "com.laundry-desk.v2";
  const shortVersion = options.shortVersion ?? "0.1.0";
  const bundleVersion = options.bundleVersion ?? shortVersion;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleName</key><string>laundry-desk V2</string>
<key>CFBundleExecutable</key><string>laundry-desk V2</string>
<key>CFBundleShortVersionString</key><string>${shortVersion}</string>
<key>CFBundleVersion</key><string>${bundleVersion}</string>
</dict></plist>
`;
}

async function createPackagedApp(
  root: string,
  name = "laundry-desk V2.app",
  options: InfoPlistOptions = {},
): Promise<AppFixture> {
  const app = join(await realpath(root), name);
  const contents = join(app, "Contents");
  const resources = join(app, "Contents", "Resources");
  const spa = join(resources, "spa");
  await mkdir(spa, { recursive: true });
  const appAsar = join(resources, "app.asar");
  const spaManifest = join(spa, "manifest.json");
  const infoPlistPath = join(contents, "Info.plist");
  await writeFile(appAsar, "packaged-asar-bytes");
  await writeFile(spaManifest, '{"version":1,"entries":{}}\n');
  await writeFile(infoPlistPath, infoPlist(options));
  return Object.freeze({ app, appAsar, spaManifest, infoPlist: infoPlistPath });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("packaged app evidence hashes the real app.asar and SPA manifest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-packaged-app-"));
  t.after(async () => rm(root, { recursive: true }));
  const fixture = await createPackagedApp(root);
  assert.deepEqual(await hashPackagedMacApp(fixture.app), {
    bundle_identifier: "com.laundry-desk.v2",
    bundle_name: "laundry-desk V2",
    bundle_executable: "laundry-desk V2",
    app_version: "0.1.0",
    app_asar_sha256: sha256("packaged-asar-bytes"),
    spa_manifest_sha256: sha256('{"version":1,"entries":{}}\n'),
    info_plist_sha256: sha256(infoPlist()),
  });
});

test("packaged app evidence rejects forged identity and version drift", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-packaged-app-identity-"));
  t.after(async () => rm(root, { recursive: true }));
  const forged = await createPackagedApp(root, "forged.app", {
    identifier: "com.attacker.lookalike",
  });
  await assert.rejects(() => hashPackagedMacApp(forged.app), /identity is invalid/u);
  const drifted = await createPackagedApp(root, "drifted.app", {
    shortVersion: "0.1.0",
    bundleVersion: "0.1.1",
  });
  await assert.rejects(() => hashPackagedMacApp(drifted.app), /identity is invalid/u);
});

test("packaged app evidence rejects symlinks, hard links, and oversized files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-packaged-app-boundary-"));
  t.after(async () => rm(root, { recursive: true }));

  const symlinkFixture = await createPackagedApp(root, "symlink-file.app");
  await rename(symlinkFixture.appAsar, `${symlinkFixture.appAsar}.real`);
  await symlink(`${symlinkFixture.appAsar}.real`, symlinkFixture.appAsar);
  await assert.rejects(() => hashPackagedMacApp(symlinkFixture.app), /single-link real file/u);

  const hardLinkFixture = await createPackagedApp(root, "hard-link.app");
  await link(hardLinkFixture.appAsar, `${hardLinkFixture.appAsar}.second-link`);
  await assert.rejects(() => hashPackagedMacApp(hardLinkFixture.app), /single-link real file/u);

  const oversizedFixture = await createPackagedApp(root, "oversized.app");
  await truncate(oversizedFixture.appAsar, 1024 * 1024 * 1024 + 1);
  await assert.rejects(() => hashPackagedMacApp(oversizedFixture.app), /bounded/u);

  const linkedPlistFixture = await createPackagedApp(root, "linked-plist.app");
  await link(linkedPlistFixture.infoPlist, `${linkedPlistFixture.infoPlist}.second-link`);
  await assert.rejects(() => hashPackagedMacApp(linkedPlistFixture.app), /single-link real file/u);

  const appSymlink = join(await realpath(root), "redirect.app");
  await symlink(hardLinkFixture.app, appSymlink);
  await assert.rejects(() => hashPackagedMacApp(appSymlink), /real directory/u);
});

test("packaged app evidence detects replacement between lstat and open", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-packaged-app-race-"));
  t.after(async () => rm(root, { recursive: true }));
  const fixture = await createPackagedApp(root);
  await assert.rejects(
    () =>
      hashPackagedMacApp(fixture.app, {
        afterLstat: async (path) => {
          if (path !== fixture.appAsar) return;
          await rename(path, `${path}.replaced`);
          await writeFile(path, "attacker-controlled");
        },
      }),
    /changed while opening/u,
  );
});

test("packaged app evidence detects Info.plist replacement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-packaged-plist-race-"));
  t.after(async () => rm(root, { recursive: true }));
  const fixture = await createPackagedApp(root);
  await assert.rejects(
    () =>
      hashPackagedMacApp(fixture.app, {
        afterLstat: async (path) => {
          if (path !== fixture.infoPlist) return;
          await rename(path, `${path}.replaced`);
          await writeFile(path, infoPlist());
        },
      }),
    /changed while opening/u,
  );
});

test("packaged app evidence detects mutation after reading", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-packaged-app-after-read-"));
  t.after(async () => rm(root, { recursive: true }));
  const fixture = await createPackagedApp(root);
  await assert.rejects(
    () =>
      hashPackagedMacApp(fixture.app, {
        afterRead: async (path) => {
          if (path === fixture.appAsar) await writeFile(path, "mutated-after-read");
        },
      }),
    /changed while reading/u,
  );
});

test("packaged app evidence rejects a cross-artifact finalization race", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-packaged-app-final-race-"));
  t.after(async () => rm(root, { recursive: true }));
  const fixture = await createPackagedApp(root);
  await assert.rejects(
    () =>
      hashPackagedMacApp(fixture.app, {
        afterLstat: async (path) => {
          if (path === fixture.spaManifest) await writeFile(fixture.appAsar, "late mutation");
        },
      }),
    /changed before evidence was finalized/u,
  );
});

test("packaged app evidence rejects replacement of the app directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-packaged-app-dir-race-"));
  t.after(async () => rm(root, { recursive: true }));
  const fixture = await createPackagedApp(root, "accepted.app");
  const replacement = await createPackagedApp(root, "replacement.app");
  await assert.rejects(
    () =>
      hashPackagedMacApp(fixture.app, {
        beforeDirectoryRecheck: async () => {
          await rename(fixture.app, `${fixture.app}.displaced`);
          await rename(replacement.app, fixture.app);
        },
      }),
    /packaged app changed before evidence was finalized/u,
  );
});

test("packaged app path errors do not reflect private paths", async () => {
  const supplied = "/private/secret/not-an-app";
  await assert.rejects(
    () => hashPackagedMacApp(supplied),
    (error: unknown) => error instanceof Error && !error.message.includes(supplied),
  );
});
