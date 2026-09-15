import { randomBytes, randomInt } from "node:crypto";
import { join } from "node:path";
import { exists } from "./lifecycle-storage.mjs";
import { cleanEnvironment, runtimeEnvironment, secretNames } from "./lifecycle-environment.mjs";
import { pgControl, run } from "./lifecycle-process.mjs";
import { fail } from "./companion-contract.mjs";

const random = () => randomBytes(32).toString("base64url");
export async function initializeSecrets(root, io) {
  const folder = join(root, "secrets");
  if (await exists(folder)) fail("PARTIAL_INITIALIZATION");
  await io.directory(folder);
  const superPassword = random();
  const appPassword = random();
  const values = {
    "postgres-superuser-password": superPassword,
    "postgres-app-password": appPassword,
    "database-admin-url": `postgresql://postgres:${superPassword}@127.0.0.1:8543/laundry_v2`,
    "database-url": `postgresql://laundry_app:${appPassword}@127.0.0.1:8543/laundry_v2`,
    "pgpass.conf": `127.0.0.1:8543:*:postgres:${superPassword}`,
    "access-token-secret": random(),
    "csrf-proof-secret": random(),
  };
  const pins = [String(randomInt(100000, 1000000))];
  do {
    pins[1] = String(randomInt(100000, 1000000));
  } while (pins[0] === pins[1]);
  for (const [index, role] of ["ADMIN", "APPROVER"].entries()) {
    for (const [field, value] of Object.entries({
      USERNAME: `${role.toLowerCase()}-win-dev`,
      DISPLAY_NAME: `Windows Dev ${role}`,
      PASSWORD: random(),
      PIN: pins[index],
    })) {
      values[secretNames[`LAUNDRY_BOOTSTRAP_${role}_${field}`]] = value;
    }
  }
  for (const [name, value] of Object.entries(values)) await io.write(join(folder, name), value);
}

export function kit(payload, command, env, root) {
  return run(
    join(payload, "node/node.exe"),
    [join(payload, "server/dist/runtime/kit-entrypoint.js"), command],
    env,
    root,
  );
}

export async function initializeDatabase(root, payload, manifest, io, platform) {
  if (await exists(join(root, "postgres-data"))) fail("PARTIAL_INITIALIZATION");
  const env = await runtimeEnvironment(root, payload, manifest, io);
  await run(
    join(payload, "postgres/bin/initdb.exe"),
    [
      `--pgdata=${join(root, "postgres-data")}`,
      "--username=postgres",
      `--pwfile=${join(root, "secrets/postgres-superuser-password")}`,
      "--encoding=UTF8",
      "--locale=C",
      "--auth-host=scram-sha-256",
      "--auth-local=scram-sha-256",
      "--data-checksums",
    ],
    cleanEnvironment(),
    root,
  );
  await platform.securePrivateDirectory(join(root, "postgres-data"));
  await platform.inspectPrivateDirectory(join(root, "postgres-data"));
  await platform.flushDirectoryDurably(root);
  await pgControl("start", root, payload, env);
  try {
    await run(
      join(payload, "postgres/bin/createdb.exe"),
      ["--host=127.0.0.1", "--port=8543", "--username=postgres", "--no-password", "laundry_v2"],
      env,
      root,
    );
    for (const command of ["roles", "migrate", "bootstrap", "verify"])
      await kit(payload, command, env, root);
  } finally {
    await pgControl("stop", root, payload, env);
  }
}

export function serverEnvironment(env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        name !== "PGPASSFILE" &&
        name !== "DATABASE_ADMIN_URL_FILE" &&
        name !== "LAUNDRY_APP_PASSWORD_FILE" &&
        !name.startsWith("LAUNDRY_BOOTSTRAP_"),
    ),
  );
}
