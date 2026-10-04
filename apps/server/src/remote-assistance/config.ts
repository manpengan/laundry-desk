import { lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { inspectPrivateDirectory } from "@laundry/platform-fs";
import { readSecretValue } from "../local/secret-file.js";
import { AssistanceTrustSchema, assistancePublicKey, type AssistanceTrust } from "./protocol.js";
import { assistanceBrokerOrigin } from "./transport.js";
import { parseRuntimeRelease } from "../runtime/runtime-release.js";

/** Only the private installed Windows runtime owns this configuration. */
export async function loadAssistanceTrust(): Promise<AssistanceTrust | null> {
  if (
    process.platform !== "win32" ||
    !process.env.LOCALAPPDATA ||
    !isAbsolute(process.env.LOCALAPPDATA) ||
    process.env.LAUNDRY_RUNTIME_RELEASE === undefined
  )
    return null;
  const root = join(process.env.LOCALAPPDATA, "laundry-desk-v2", "runtime-companion");
  const secrets = join(root, "secrets");
  // Development/fixture processes and shadow probes must not borrow a live
  // installation's broker token merely because they use the same OS account.
  if (
    !process.env.DATABASE_URL_FILE ||
    resolve(process.env.DATABASE_URL_FILE).toLowerCase() !==
      join(secrets, "database-url").toLowerCase()
  )
    return null;
  parseRuntimeRelease(process.env);
  const path = join(secrets, "remote-assistance.json");
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  await inspectPrivateDirectory(root);
  await inspectPrivateDirectory(secrets);
  const raw = readSecretValue({ ASSISTANCE_FILE: path }, "ASSISTANCE");
  const parsed: unknown = JSON.parse(raw ?? "null");
  if (parsed === null) return null;
  const trust = AssistanceTrustSchema.parse(parsed);
  assistancePublicKey(trust);
  assistanceBrokerOrigin(trust.broker_url);
  return Object.freeze(trust);
}
