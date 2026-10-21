import { readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { exactKeys, fail, supportsStoreInitialization } from "./companion-contract.mjs";
import { exists } from "./lifecycle-storage.mjs";
import { bootstrapSecretNames } from "./lifecycle-environment.mjs";

const FIELDS = Object.freeze(["username", "displayName", "password", "pin"]);
const INPUT_DIRECTORY = "bootstrap-input";

export function requireStoreInput(value) {
  if (
    !exactKeys(value, ["version", "mode", "admin", "approver"]) ||
    value.version !== 1 ||
    value.mode !== "new_empty" ||
    ![value.admin, value.approver].every(
      (person) =>
        exactKeys(person, FIELDS) &&
        FIELDS.every(
          (field) => typeof person[field] === "string" && !/[\r\n\0]/u.test(person[field]),
        ),
    )
  )
    fail("STORE_INPUT_INVALID");
  return value;
}

// Import only from an already inspected, fixed payload. The server remains the
// authority for identity rules; the wire format never accepts tenant identifiers.
export async function validateStoreInput(payload, manifest, value) {
  requireStoreInput(value);
  if (!supportsStoreInitialization(manifest)) fail("STORE_INITIALIZATION_UNAVAILABLE");
  try {
    const [{ BootstrapInputSchema }, { LOCAL_PROFILE }] = await Promise.all([
      import(pathToFileURL(join(payload, "server/dist/local/bootstrap-model.js")).href),
      import(pathToFileURL(join(payload, "server/dist/local/profile.js")).href),
    ]);
    return BootstrapInputSchema.parse({
      profile: LOCAL_PROFILE,
      demoOnly: false,
      adminUsername: value.admin.username,
      adminDisplayName: value.admin.displayName,
      adminPassword: value.admin.password,
      adminPin: value.admin.pin,
      approverUsername: value.approver.username,
      approverDisplayName: value.approver.displayName,
      approverPassword: value.approver.password,
      approverPin: value.approver.pin,
    });
  } catch {
    fail("STORE_INPUT_INVALID");
  }
}

export function requireFreshStore(action, existed) {
  if (action === "install-store" && existed) fail("STORE_REQUIRES_NEW_INSTANCE");
}

export function requireStoreRuntime(state, manifest) {
  if (state?.schema === 2 && !supportsStoreInitialization(manifest))
    fail("STORE_RUNTIME_VERSION_REQUIRED");
}

export async function clearStoreInput(root, platform) {
  const directory = join(root, INPUT_DIRECTORY);
  if (!(await exists(directory))) return;
  try {
    await platform.inspectPrivateDirectory(directory);
    const allowed = new Set(Object.values(bootstrapSecretNames));
    const names = await readdir(directory);
    // The atomic private writer may leave its own temporary file after a crash.
    const atomicTemporary =
      /^\.commit-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
    if (names.some((name) => !allowed.has(name) && !atomicTemporary.test(name)))
      fail("STORE_INPUT_CLEANUP_FAILED");
    // Check the whole set before removing anything; never recursively remove data.
    for (const name of names) await platform.inspectPrivateFile(join(directory, name));
    for (const name of names) await unlink(join(directory, name));
    await platform.flushDirectoryDurably(directory);
    await rmdir(directory);
    await platform.flushDirectoryDurably(root);
  } catch {
    fail("STORE_INPUT_CLEANUP_FAILED");
  }
}

export async function withStoreInput(root, input, io, platform, action) {
  const directory = join(root, INPUT_DIRECTORY);
  if (await exists(directory)) fail("STORE_INPUT_CONFLICT");
  await io.directory(directory);
  try {
    for (const [role, prefix] of [
      ["ADMIN", "admin"],
      ["APPROVER", "approver"],
    ]) {
      for (const [field, suffix] of [
        ["USERNAME", "Username"],
        ["DISPLAY_NAME", "DisplayName"],
        ["PASSWORD", "Password"],
        ["PIN", "Pin"],
      ]) {
        await io.write(
          join(directory, bootstrapSecretNames[`LAUNDRY_BOOTSTRAP_${role}_${field}`]),
          input[`${prefix}${suffix}`],
        );
      }
    }
    return await action(directory);
  } finally {
    await clearStoreInput(root, platform);
  }
}
