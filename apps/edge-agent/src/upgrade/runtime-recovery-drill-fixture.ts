import { createHash, generateKeyPairSync } from "node:crypto";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  signReleaseManifest,
  verifyReleaseManifest,
  type SignedReleaseManifest,
} from "./release-manifest.js";
import { RuntimeUpdateController } from "./runtime-controller.js";
import { createRuntimeUpdateIo, type RuntimeUpdateIo, type UpdateFetch } from "./runtime-io.js";
import { RuntimeUpdateStateStore } from "./runtime-state.js";

export const DRILL_MANIFEST_URL = "https://updates.example.test/stable/latest.json";
export const DRILL_OLD_APP = "/Applications/laundry-desk V2.app";
export const DRILL_ARTIFACT_NAME = "laundry-desk-2.0.0-mac.zip";
export const DRILL_RELEASE_ID = "01a2eed0-a6c3-493c-a3a7-20bf94b1d678";
export const DRILL_ACTIVATION_ID = "11a2eed0-a6c3-493c-a3a7-20bf94b1d678";
export const DRILL_ARTIFACT = Buffer.from("production-isomorphic-update-zip", "utf8");

const DRILL_ARTIFACT_URL = `https://updates.example.test/stable/${DRILL_ARTIFACT_NAME}`;
const DRILL_DIGEST = createHash("sha256").update(DRILL_ARTIFACT).digest("hex");
const DRILL_NOW = "2026-07-31T03:04:05.000Z";

export type DrillOptions = Readonly<{
  manifest: "valid" | "tampered";
  download: "valid" | "interrupted" | "digest_mismatch";
  extract: "valid" | "interrupted" | "team_mismatch";
  health: boolean;
  pendingCount: number;
  inflightCount: number;
}>;

export type DrillHarness = Readonly<{
  root: string;
  state: RuntimeUpdateStateStore;
  controller: RuntimeUpdateController;
  controllerFor: (state: RuntimeUpdateStateStore) => RuntimeUpdateController;
  releaseEntries: () => Promise<readonly string[]>;
  fetchCount: () => number;
  leaseBlocks: () => readonly boolean[];
}>;

export const DEFAULT_DRILL_OPTIONS: DrillOptions = Object.freeze({
  manifest: "valid",
  download: "valid",
  extract: "valid",
  health: true,
  pendingCount: 0,
  inflightCount: 0,
});

function createSignedManifest(): Readonly<{
  manifest: SignedReleaseManifest;
  publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"];
}> {
  const keys = generateKeyPairSync("ed25519");
  const manifest = signReleaseManifest(
    {
      protocol_version: 1,
      channel: "stable",
      version: "2.0.0",
      minimum_secure_version: "1.0.0",
      minimum_upgradable_version: "0.9.0",
      contracts_major: 1,
      local_schema: 3,
      published_at: DRILL_NOW,
      artifacts: [
        {
          kind: "zip",
          name: DRILL_ARTIFACT_NAME,
          size_bytes: DRILL_ARTIFACT.byteLength,
          sha256: DRILL_DIGEST,
        },
      ],
      rollback: {
        target_version: "1.0.0",
        artifact_sha256: createHash("sha256").update("installed-v1", "utf8").digest("hex"),
        max_compatible_local_schema: 3,
      },
    },
    keys.privateKey,
  );
  const verified = verifyReleaseManifest(manifest, keys.publicKey, {
    channel: "stable",
    current_version: "1.0.0",
    installed_minimum_secure_version: "1.0.0",
    current_local_schema: 3,
    supported_contracts_majors: [1],
  });
  if (!verified.ok) throw new Error("Drill could not verify its ephemeral release trust root");
  return Object.freeze({ manifest, publicKey: keys.publicKey });
}

function tamperSignature(manifest: SignedReleaseManifest): SignedReleaseManifest {
  const first = manifest.signature.startsWith("A") ? "B" : "A";
  return Object.freeze({
    authority: manifest.authority,
    signature: `${first}${manifest.signature.slice(1)}`,
  });
}

function interruptedResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(DRILL_ARTIFACT.subarray(0, 8));
      controller.error(new Error("simulated artifact transport interruption"));
    },
  });
  return new Response(body, { status: 200 });
}

function artifactResponse(mode: DrillOptions["download"]): Response {
  if (mode === "interrupted") return interruptedResponse();
  if (mode === "digest_mismatch") {
    return new Response(Buffer.alloc(DRILL_ARTIFACT.byteLength, 0x78), { status: 200 });
  }
  return new Response(DRILL_ARTIFACT, { status: 200 });
}

function createFetch(
  manifest: SignedReleaseManifest,
  mode: DrillOptions["download"],
  increment: () => void,
): UpdateFetch {
  return async (input, init) => {
    increment();
    if (init.redirect !== "manual" || init.signal.aborted) {
      throw new Error("Drill observed unsafe update fetch options");
    }
    if (input === DRILL_MANIFEST_URL) {
      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (input === DRILL_ARTIFACT_URL) return artifactResponse(mode);
    throw new Error("Drill update fetch escaped the fixed release origin");
  };
}

function createExtractor(mode: DrillOptions["extract"]): RuntimeUpdateIo["extractAndVerifyMacApp"] {
  return async (zipPath, destinationDirectory) => {
    const zip = await lstat(zipPath);
    if (!zip.isFile() || zip.isSymbolicLink()) {
      throw new Error("Drill received an unsafe downloaded artifact");
    }
    const extracting = join(destinationDirectory, ".app-extracting");
    if (mode === "interrupted") {
      await mkdir(extracting, { mode: 0o700 });
      throw new Error("simulated macOS extraction interruption");
    }
    if (mode === "team_mismatch") {
      await mkdir(join(extracting, "laundry-desk V2.app"), {
        recursive: true,
        mode: 0o700,
      });
      throw new Error("Update app signing team does not match");
    }
    const appPath = join(destinationDirectory, "payload", "laundry-desk V2.app");
    await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true, mode: 0o700 });
    return appPath;
  };
}

function isMissingDirectory(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    Reflect.get(error, "code") === "ENOENT"
  );
}

export function reopenDrillState(root: string): RuntimeUpdateStateStore {
  return new RuntimeUpdateStateStore(root, {
    currentVersion: "1.0.0",
    currentAppPath: DRILL_OLD_APP,
    minimumSecureVersion: "1.0.0",
    now: () => DRILL_NOW,
  });
}

export async function createDrillHarness(
  root: string,
  options: DrillOptions = DEFAULT_DRILL_OPTIONS,
): Promise<DrillHarness> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const signed = createSignedManifest();
  const served =
    options.manifest === "tampered" ? tamperSignature(signed.manifest) : signed.manifest;
  let networkCount = 0;
  let leaseHistory: readonly boolean[] = Object.freeze([]);
  let identifiers: readonly string[] = Object.freeze([DRILL_RELEASE_ID, DRILL_ACTIVATION_ID]);
  const productionIo = createRuntimeUpdateIo(
    createFetch(served, options.download, () => {
      networkCount += 1;
    }),
  );
  const io: RuntimeUpdateIo = Object.freeze({
    ...productionIo,
    extractAndVerifyMacApp: createExtractor(options.extract),
  });
  const controllerFor = (state: RuntimeUpdateStateStore): RuntimeUpdateController =>
    new RuntimeUpdateController({
      manifestUrl: DRILL_MANIFEST_URL,
      publicKey: signed.publicKey,
      context: {
        channel: "stable",
        current_version: "1.0.0",
        installed_minimum_secure_version: "1.0.0",
        current_local_schema: 3,
        supported_contracts_majors: [1],
      },
      state,
      io,
      queueStatus: () =>
        Object.freeze({
          pendingCount: options.pendingCount,
          inflightCount: options.inflightCount,
          storageVersion: 1 as const,
          hasDek: true,
          kekKeyVersion: 1,
        }),
      stagedHealth: async (appPath) =>
        appPath.endsWith("/payload/laundry-desk V2.app") && options.health,
      setPrimaryLeaseBlocked: (blocked) => {
        leaseHistory = Object.freeze([...leaseHistory, blocked]);
      },
      randomId: () => {
        const next = identifiers[0];
        if (next === undefined) throw new Error("Drill exhausted deterministic public identifiers");
        identifiers = Object.freeze(identifiers.slice(1));
        return next;
      },
      now: () => DRILL_NOW,
    });
  const state = reopenDrillState(root);
  return Object.freeze({
    root: state.root,
    state,
    controller: controllerFor(state),
    controllerFor,
    releaseEntries: async () => {
      try {
        return Object.freeze([...(await readdir(join(state.root, "slots", "B")))].sort());
      } catch (error) {
        if (isMissingDirectory(error)) return Object.freeze([]);
        throw error;
      }
    },
    fetchCount: () => networkCount,
    leaseBlocks: () => leaseHistory,
  });
}
