/** Isolated synthetic PostgreSQL gate; never uses an existing database URL. */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { setTimeout } from "node:timers/promises";
const require = createRequire(resolve("apps/server/package.json"));
const { Pool } = require("pg");
const root = await mkdtemp(join(tmpdir(), "laundry-v1-pg-"));
const name = `laundry-v1-pg-${randomBytes(6).toString("hex")}`;
const password = randomBytes(32).toString("hex");
const appPassword = randomBytes(32).toString("hex");
const run = (command, args, env = process.env) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (value) => {
      stdout += value;
    });
    child.stderr.on("data", (value) => {
      stderr += value;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolveRun(stdout)
        : reject(
            new Error(`${command} exit ${code}: ${stderr.slice(-2000)}${stdout.slice(-2000)}`),
          ),
    );
  });
let admin;
try {
  await writeFile(join(root, "pg.env"), `POSTGRES_DB=laundry_v2\nPOSTGRES_PASSWORD=${password}\n`, {
    mode: 0o600,
  });
  await run("docker", [
    "run",
    "--name",
    name,
    "--detach",
    "--env-file",
    join(root, "pg.env"),
    "-p",
    "127.0.0.1::5432",
    "postgres:16-alpine",
  ]);
  const port = (await run("docker", ["port", name, "5432/tcp"])).trim().split(":").at(-1);
  const adminUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/laundry_v2`;
  const appUrl = `postgresql://laundry_app:${appPassword}@127.0.0.1:${port}/laundry_v2`;
  admin = new Pool({ connectionString: adminUrl, max: 1 });
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await admin.query("SELECT 1");
      ready = true;
      break;
    } catch {
      await setTimeout(500);
    }
  }
  if (!ready) throw new Error("synthetic PostgreSQL did not start");
  const dir = resolve("packages/db/src/migrations");
  const files = (await readdir(dir)).filter((file) => /^\d{4}_.*\.sql$/u.test(file)).sort();
  for (const file of files) {
    const sql = await readFile(join(dir, file), "utf8");
    if (file === "0001_roles.sql") {
      await admin.query(sql);
      await admin.query("ALTER DATABASE laundry_v2 OWNER TO laundry_owner");
      await admin.query("GRANT ALL ON SCHEMA public TO laundry_owner");
      await admin.query(`ALTER ROLE laundry_app PASSWORD '${appPassword}'`);
    } else {
      try {
        await admin.query(`BEGIN; SET LOCAL ROLE laundry_owner;\n${sql}\nCOMMIT;`);
      } catch (error) {
        throw new Error(`migration ${file}: ${error.message}`, { cause: error });
      }
    }
  }
  process.stdout.write(`Applied ${files.length} migrations in isolated synthetic PG.\n`);
  const output = await run(
    process.execPath,
    ["--test", "--test-concurrency=1", ...process.argv.slice(2)],
    {
      ...process.env,
      LAUNDRY_USE_LOCAL_PG: "1",
      LAUNDRY_PG_APP_URL: appUrl,
      DATABASE_ADMIN_URL: adminUrl,
    },
  );
  process.stdout.write(output);
} finally {
  await admin?.end();
  await run("docker", ["rm", "--force", name]).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
