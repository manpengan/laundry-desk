import { createHash } from "node:crypto";
import { z } from "zod";

const HASH = /^[a-f0-9]{64}$/u;
const SOURCE = /^[a-f0-9]{40}$/u;
const Result = z.strictObject({
  status: z.enum(["running", "stopped"]),
  assurance: z.literal("development_only"),
  source_git_sha: z.string().regex(SOURCE),
  manifest_sha256: z.string().regex(HASH),
  migration_head: z.string().min(1).max(128),
});

/** @param {Buffer} bytes @param {string} expectedDigest */
export function boundEntryTrust(bytes, expectedDigest) {
  try {
    if (
      bytes.length < 1 ||
      bytes.length > 262_144 ||
      !HASH.test(expectedDigest) ||
      createHash("sha256").update(bytes).digest("hex") !== expectedDigest
    )
      throw new Error("INVALID");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const fragments = [...text.matchAll(/Add-Type -TypeDefinition @'\r?\n[\s\S]*?\r?\n'@/gu)];
    const fragment = fragments[0]?.[0];
    if (
      fragments.length !== 1 ||
      typeof fragment !== "string" ||
      !fragment.includes("public static class LaundryRuntimeEntryTrust {")
    ) {
      throw new Error("INVALID");
    }
    return fragment;
  } catch {
    throw new Error("WINDOWS_OFFLINE_ENTRY_TRUST_INVALID");
  }
}

/** @param {string} output @param {"status" | "start" | "stop"} verb @param {string} source @param {string} manifest */
export function boundRuntimeResult(output, verb, source, manifest) {
  try {
    if (!SOURCE.test(source) || !HASH.test(manifest) || output.length > 65_536)
      throw new Error("INVALID");
    const value = /** @type {unknown} */ (JSON.parse(output));
    const parsed = Result.safeParse(value);
    if (
      !parsed.success ||
      JSON.stringify(value) !== output ||
      parsed.data.source_git_sha !== source ||
      parsed.data.manifest_sha256 !== manifest ||
      parsed.data.status !== (verb === "stop" ? "stopped" : "running")
    )
      throw new Error("INVALID");
    return parsed.data;
  } catch {
    throw new Error("WINDOWS_OFFLINE_RUNTIME_BINDING_INVALID");
  }
}

/** @param {(verb: "status" | "start" | "stop") => Promise<unknown>} run */
export function createControllerGate(run) {
  /** @type {"ready" | "active" | "recovery"} */
  let state = "ready";
  return Object.freeze({
    recoveryRequired: () => state === "recovery",
    /** @param {"status" | "start" | "stop"} verb */
    action: async (verb) => {
      if (state !== "ready") throw new Error("WINDOWS_OFFLINE_RECOVERY_REQUIRED");
      if (!["status", "start", "stop"].includes(verb))
        throw new Error("WINDOWS_OFFLINE_ACTION_INVALID");
      state = "active";
      try {
        const result = await run(verb);
        state = "ready";
        return result;
      } catch {
        state = "recovery";
        throw new Error("WINDOWS_OFFLINE_CONTROLLER_UNCONFIRMED");
      }
    },
  });
}
