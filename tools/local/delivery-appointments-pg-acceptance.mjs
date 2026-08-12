import { spawn } from "node:child_process";

import { loadLocalConfig } from "./config.mjs";

const required = (name) => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error("DELIVERY_APPOINTMENTS_PG_INPUT_REQUIRED");
  }
  return value;
};

const project = required("COMPOSE_PROJECT_NAME");
if (
  process.env.LAUNDRY_COMMISSIONING_ACCEPTANCE_ISOLATED !== "1" ||
  !/^laundry-commission-pg-[a-z0-9]+$/u.test(project)
) {
  throw new Error("DELIVERY_APPOINTMENTS_PG_ISOLATION_REQUIRED");
}

const config = await loadLocalConfig({ env: process.env });
const databaseUrl = (username, password) => {
  const url = new URL("postgresql://127.0.0.1:8543/laundry_v2");
  url.username = username;
  url.password = password;
  return url.toString();
};
const environment = Object.freeze({
  ...process.env,
  LAUNDRY_USE_LOCAL_PG: "1",
  LAUNDRY_PG_APP_URL: databaseUrl("laundry_app", config.postgresAppPassword),
  DATABASE_ADMIN_URL: databaseUrl("postgres", config.postgresSuperuserPassword),
});

const exitCode = await new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [
      "--test",
      "--test-concurrency=1",
      "apps/server/dist/delivery-appointments/pg-invariants.test.js",
    ],
    { cwd: process.cwd(), env: environment, shell: false, stdio: "inherit" },
  );
  child.once("error", reject);
  child.once("exit", (code) => resolve(code ?? 1));
});

if (exitCode !== 0) throw new Error("DELIVERY_APPOINTMENTS_PG_ACCEPTANCE_FAILED");
process.stdout.write("ADR47_DELIVERY_APPOINTMENTS_PG_ACCEPTANCE_OK\n");
