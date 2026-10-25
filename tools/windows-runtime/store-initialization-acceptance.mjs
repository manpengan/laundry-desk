// CI only: copied beside the harness, never into the distributed Runtime payload.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { storeAcceptanceFailure } from "./lifecycle-acceptance-command.mjs";

function requireResult(condition, code) {
  if (!condition) throw new Error(`WINDOWS_COMPANION_STORE_ACCEPTANCE_${code}`);
}

export function syntheticStoreInput() {
  const adminPin = String(randomInt(10000000, 100000000));
  let approverPin;
  do {
    approverPin = String(randomInt(10000000, 100000000));
  } while (approverPin === adminPin);
  const person = (role, pin) => ({
    username: `qa-${role}-${randomBytes(8).toString("hex")}`,
    displayName: `合成${role === "owner" ? "店长" : "复核员"}-${randomBytes(6).toString("hex")}`,
    password: `${role}-${randomBytes(32).toString("base64url")}`,
    pin,
  });
  return {
    version: 1,
    mode: "new_empty",
    admin: person("owner", adminPin),
    approver: person("reviewer", approverPin),
  };
}

export async function requireNoBootstrapInputs(root) {
  let missing = false;
  try {
    await lstat(join(root, "bootstrap-input"));
  } catch (error) {
    if (error.code === "ENOENT") missing = true;
    else throw new Error("WINDOWS_COMPANION_STORE_ACCEPTANCE_INPUT_INSPECTION_FAILED");
  }
  requireResult(missing, "INPUT_RETAINED");
  const names = await readdir(join(root, "secrets"));
  requireResult(
    !names.some((name) => name.toLowerCase().startsWith("laundry-bootstrap-")),
    "CREDENTIAL_FILE_RETAINED",
  );
}

export async function requireStoreInitializationInvariant(root, io) {
  const state = JSON.parse(await io.read(join(root, "state.json")));
  requireResult(state?.schema === 2, "STATE_SCHEMA_INVALID");
  await requireNoBootstrapInputs(root);
}

export async function runtimeSecretDigest(root, digest) {
  const names = (await readdir(join(root, "secrets"))).sort();
  const files = await Promise.all(
    names.map(async (name) => ({
      name,
      sha256: digest(await readFile(join(root, "secrets", name))),
    })),
  );
  return digest(Buffer.from(JSON.stringify(files)));
}

export async function requireNoInputLogs(root, input) {
  const logs = join(root, "logs");
  const directory = await lstat(logs);
  requireResult(directory.isDirectory() && !directory.isSymbolicLink(), "LOG_DIRECTORY_INVALID");
  const names = await readdir(logs);
  requireResult(names.length <= 32, "LOG_LIMIT");
  const values = [...Object.values(input.admin), ...Object.values(input.approver)];
  for (const name of names) {
    requireResult(!values.some((value) => name.includes(value)), "INPUT_LOGGED");
    const path = join(logs, name);
    const before = await lstat(path);
    const limit = 2 * 1024 * 1024;
    requireResult(
      before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= limit,
      "LOG_FILE_INVALID",
    );
    const file = await open(path, "r");
    const bytes = Buffer.alloc(limit + 1);
    try {
      const opened = await file.stat();
      requireResult(
        opened.ino === before.ino && opened.dev === before.dev && opened.nlink === 1,
        "LOG_FILE_CHANGED",
      );
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      requireResult(size <= limit, "LOG_LIMIT");
      requireResult(
        !values.some((value) => bytes.subarray(0, size).includes(value)),
        "INPUT_LOGGED",
      );
    } finally {
      bytes.fill(0);
      await file.close();
    }
  }
}

async function boundedJson(response) {
  requireResult(response.status === 200 && response.body !== null, "LOGIN_REJECTED");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      requireResult(size <= 65536, "LOGIN_RESPONSE_LIMIT");
      chunks.push(Buffer.from(item.value));
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    await reader.cancel();
    reader.releaseLock();
    for (const chunk of chunks) chunk.fill(0);
  }
}

export async function verifyStoreLogin(person, staffId, profile, request = fetch) {
  const deviceId = randomUUID();
  const response = await request("http://127.0.0.1:8787/api/v2/auth/login", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:8787",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({
      org_code: profile.orgCode,
      store_code: profile.storeCode,
      username: person.username,
      password: person.password,
      device_id: deviceId,
    }),
  });
  const value = await boundedJson(response);
  requireResult(
    value.ok === true &&
      value.data?.role === "admin" &&
      value.data.storage === "memory_only" &&
      value.data.session?.staff_id === staffId &&
      value.data.session.org_id === profile.orgId &&
      value.data.session.store_id === profile.storeId &&
      value.data.session.device_id === deviceId &&
      value.data.display?.staff_name === person.displayName &&
      typeof value.data.access_token === "string" &&
      value.data.access_token.length > 10,
    "LOGIN_IDENTITY_INVALID",
  );
}

async function databaseTools({ root, payload, io }) {
  const { Pool } = createRequire(join(payload, "server/package.json"))("pg");
  const [{ createArgon2idPasswordPort }, { LOCAL_PROFILE }] = await Promise.all([
    import(pathToFileURL(join(payload, "server/dist/identity/password.js")).href),
    import(pathToFileURL(join(payload, "server/dist/local/profile.js")).href),
  ]);
  const pool = new Pool({
    connectionString: await io.read(join(root, "secrets/database-admin-url")),
    max: 1,
  });
  return { pool, passwordPort: createArgon2idPasswordPort(), profile: LOCAL_PROFILE };
}

export async function verifyStoreIdentities(context, input, dependencies = {}) {
  const { pool, passwordPort, profile } = await (dependencies.databaseTools ?? databaseTools)(
    context,
  );
  try {
    const staffs = await pool.query(
      "SELECT id, username, display_name, password_hash, pin_hash, is_active FROM public.staffs WHERE org_id=$1",
      [profile.orgId],
    );
    const roles = await pool.query(
      "SELECT staff_id, role, is_privacy_admin, is_active FROM public.staff_store_roles WHERE org_id=$1 AND store_id=$2",
      [profile.orgId, profile.storeId],
    );
    requireResult(staffs.rows.length === 2 && roles.rows.length === 2, "IDENTITY_COUNT_INVALID");
    for (const person of [input.admin, input.approver]) {
      const row = staffs.rows.find((row) => row.username === person.username);
      requireResult(
        row?.display_name === person.displayName && row.is_active === true,
        "IDENTITY_INVALID",
      );
      const role = roles.rows.find((role) => role.staff_id === row.id);
      requireResult(
        role?.role === "admin" && role.is_active === true && role.is_privacy_admin === true,
        "ROLE_INVALID",
      );
      requireResult(
        typeof row.password_hash === "string" &&
          row.password_hash.startsWith("$argon2id$") &&
          typeof row.pin_hash === "string" &&
          row.pin_hash.startsWith("$argon2id$"),
        "HASH_KIND_INVALID",
      );
      requireResult(
        await passwordPort.verifyPassword(person.password, row.password_hash),
        "PASSWORD_INVALID",
      );
      requireResult(await passwordPort.verifyPassword(person.pin, row.pin_hash), "PIN_INVALID");
      await (dependencies.login ?? verifyStoreLogin)(person, row.id, profile);
    }
  } finally {
    await pool.end();
  }
}

async function verifyInitializedStore(context, input, verifyIdentities) {
  const { command, root, payload, io, load, manifest, sql, secretDigest } = context;
  const result = await command("install-store", undefined, undefined, input);
  requireResult(
    result.status === "running" &&
      result.initialization === "operator_new_empty" &&
      result.admission === "pending" &&
      result.assurance === "development_only",
    "RESULT_INVALID",
  );
  await requireStoreInitializationInvariant(root, io);
  const { runtimeEnvironment } = await load("lifecycle-environment.mjs");
  const { kit } = await load("lifecycle-database.mjs");
  const env = await runtimeEnvironment(root, payload, manifest, io);
  requireResult(
    !Object.keys(env).some((key) => key.startsWith("LAUNDRY_BOOTSTRAP_")),
    "BOOTSTRAP_ENV_RETAINED",
  );
  await kit(payload, "verify-commissioned", env, root);
  const status = JSON.parse(await kit(payload, "commission-status", env, root));
  requireResult(status.commission_required === false, "NOT_COMMISSIONED");
  await verifyIdentities(context, input);
  await requireNoInputLogs(root, input);
  requireResult((await sql("SHOW data_checksums")) === "on", "DATA_CHECKSUMS_DISABLED");
  requireResult((await sql("SHOW password_encryption")) === "scram-sha-256", "SCRAM_DISABLED");
  await sql(
    "CREATE TABLE public.runtime_acceptance_probe (id integer PRIMARY KEY); INSERT INTO public.runtime_acceptance_probe VALUES (1), (2)",
  );
  return secretDigest();
}

async function verifyExistingStoreRefusal(context, beforeSecrets) {
  const { command, root, io, sql, secretDigest } = context;
  const state = await io.read(join(root, "state.json"));
  const rejectedInput = syntheticStoreInput();
  let refused = false;
  try {
    await command("install-store", undefined, undefined, rejectedInput);
  } catch (error) {
    refused = /^WINDOWS_COMPANION_STORE_REQUIRES_NEW_INSTANCE$/mu.test(error.stderr ?? "");
  }
  requireResult(refused, "EXISTING_ROOT_NOT_REFUSED");
  requireResult(
    (await io.read(join(root, "state.json"))) === state && (await secretDigest()) === beforeSecrets,
    "EXISTING_ROOT_CHANGED",
  );
  requireResult(
    (await sql("SELECT count(*) FROM public.runtime_acceptance_probe")) === "2",
    "EXISTING_DATABASE_CHANGED",
  );
  await requireStoreInitializationInvariant(root, io);
  await requireNoInputLogs(root, rejectedInput);
}

export async function storeInitializationAcceptance(context, dependencies = {}) {
  const { scenario, load, manifest } = context;
  const { supportsStoreInitialization } = await load("companion-contract.mjs");
  requireResult(
    typeof supportsStoreInitialization === "function" && supportsStoreInitialization(manifest),
    "CAPABILITY_REQUIRED",
  );
  let input = syntheticStoreInput();
  let beforeSecrets;
  try {
    await scenario("install-store-real-database-and-independent-identities", async () => {
      beforeSecrets = await verifyInitializedStore(
        context,
        input,
        dependencies.verifyIdentities ?? verifyStoreIdentities,
      );
    });
    await scenario("existing-store-refuses-reinitialization-without-mutation", () =>
      verifyExistingStoreRefusal(context, beforeSecrets),
    );
    return beforeSecrets;
  } catch (error) {
    throw storeAcceptanceFailure(error, [input.admin, input.approver].flatMap(Object.values));
  } finally {
    input = null;
  }
}
