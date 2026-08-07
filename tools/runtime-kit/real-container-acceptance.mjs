import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

const dockerCandidates = [
  "/Applications/Docker.app/Contents/Resources/bin/docker",
  "/usr/local/bin/docker",
  "/opt/homebrew/bin/docker",
];
let docker;
for (const candidate of dockerCandidates) {
  try {
    await access(candidate);
    docker = candidate;
    break;
  } catch {
    // Try the next fixed installation location.
  }
}
if (docker === undefined) throw new Error("RUNTIME_DOCKER_UNAVAILABLE");

const run = (argv, options = {}) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(docker, argv, {
      env: { PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const errors = [];
    const output = [];
    let outputBytes = 0;
    child.stderr.on("data", (chunk) => {
      if (Buffer.concat(errors).length + chunk.length <= 65_536) errors.push(chunk);
    });
    const outputTask = options.output
      ? pipeline(child.stdout, createWriteStream(options.output, { flags: "wx", mode: 0o600 }))
      : new Promise((resolveOutput, rejectOutput) => {
          child.stdout.on("data", (chunk) => {
            outputBytes += chunk.length;
            if (outputBytes > 65_536) rejectOutput(new Error("RUNTIME_TEST_OUTPUT_TOO_LARGE"));
            else output.push(chunk);
          });
          child.stdout.once("end", resolveOutput);
        });
    if (options.input) createReadStream(options.input).pipe(child.stdin);
    else child.stdin.end();
    child.once("error", rejectRun);
    child.once("close", async (code) => {
      try {
        await outputTask;
        const accepting = options.accepting ?? [0];
        if (!accepting.includes(code)) {
          throw new Error(
            `RUNTIME_TEST_COMMAND_FAILED ${options.label ?? "UNLABELED"} ${Buffer.concat(errors).toString("utf8")}`,
          );
        }
        resolveRun(Buffer.concat(output).toString("utf8"));
      } catch (error) {
        rejectRun(error);
      }
    });
  });

const pinnedImage = async (tag) => {
  const value = (
    await run(["image", "inspect", "--format", "{{index .RepoDigests 0}}", tag])
  ).trim();
  assert.match(value, /^[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$/u);
  return value;
};
const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const fileRecord = async (path, name) => ({
  name,
  size: (await stat(path)).size,
  sha256: await digest(path),
});

const suffix = randomBytes(8).toString("hex");
const postgresContainer = `laundry-runtime-recovery-pg-${suffix}`;
const databaseVolume = `laundry-runtime-recovery-db-${suffix}`;
const photoVolume = `laundry-runtime-recovery-photos-${suffix}`;
const temporary = await mkdtemp(join(tmpdir(), "laundry-runtime-real-recovery-"));
const backups = join(temporary, "backups");
await mkdir(backups, { mode: 0o700 });
const databaseDump = join(backups, "database.dump");
const photoArchive = join(backups, "photos.tar");
const safetyDump = join(backups, "safety-database.dump");
const safetyPhotos = join(backups, "safety-photos.tar");
const manifestPath = join(backups, "manifest.json");

const postgresImage = await pinnedImage("postgres:16");
const fileImage = await pinnedImage("node:22-bookworm-slim");
const photoMount = `type=volume,source=${photoVolume},target=/photos`;
const secureContainer = [
  "run",
  "--rm",
  "--interactive",
  "--network",
  "none",
  "--read-only",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--pids-limit",
  "64",
];
const databaseCommand = (tool, rest = []) => [
  "exec",
  "-i",
  "--user",
  "postgres",
  postgresContainer,
  tool,
  ...rest,
];
const photoCommand = (writable, entrypoint, rest) => [
  ...secureContainer,
  "--user",
  "10001:10001",
  "--mount",
  `${photoMount}${writable ? "" : ",readonly"}`,
  "--entrypoint",
  entrypoint,
  fileImage,
  ...rest,
];
const validatePhotos = () =>
  run(
    photoCommand(false, "/usr/local/bin/node", [
      "-e",
      "const fs=require('node:fs');const p='/photos';const ns=fs.readdirSync(p);const ok=/^(?:\\.laundry-photo-store-v1|[0-9a-f-]{36}\\.(?:jpg|png|webp))$/u;let marker=false;for(const n of ns){const s=fs.lstatSync(p+'/'+n);if(!ok.test(n)||!s.isFile()||s.nlink!==1||s.size<1)process.exit(21);if(n==='.laundry-photo-store-v1')marker=true;}if(!marker)process.exit(22);",
    ]),
  );
const archivePhotos = (output) =>
  run(
    photoCommand(false, "/bin/tar", [
      "--create",
      "--file=-",
      "--directory=/photos",
      "--format=posix",
      "--sort=name",
      "--one-file-system",
      ".",
    ]),
    { output, label: "PHOTO_ARCHIVE" },
  );
const dumpDatabase = (output) =>
  run(
    databaseCommand("pg_dump", [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      "--dbname=laundry_v2",
    ]),
    { output, label: "DATABASE_DUMP" },
  );
const verifySet = async (database, photos) => {
  await run(databaseCommand("pg_restore", ["--list", "--file=/dev/null"]), {
    input: database,
    label: "DATABASE_VERIFY",
  });
  await run(photoCommand(false, "/bin/tar", ["--list", "--file=-"]), {
    input: photos,
    label: "PHOTO_VERIFY",
  });
};

try {
  await run(["volume", "create", "--label", "com.laundry-desk.managed=true", databaseVolume]);
  await run(["volume", "create", "--label", "com.laundry-desk.managed=true", photoVolume]);
  await run([
    "run",
    "-d",
    "--name",
    postgresContainer,
    "--network",
    "none",
    "--mount",
    `type=volume,source=${databaseVolume},target=/var/lib/postgresql/data`,
    "--env",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "--env",
    "POSTGRES_DB=laundry_v2",
    postgresImage,
  ]);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = await run(
      databaseCommand("psql", ["-At", "-d", "laundry_v2", "-c", "SELECT 1"]),
      { accepting: [0, 1, 2] },
    );
    if (probe.trim() === "1") break;
    if (attempt === 59) throw new Error("RUNTIME_TEST_POSTGRES_NOT_READY");
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  await run(
    databaseCommand("psql", [
      "-v",
      "ON_ERROR_STOP=1",
      "-d",
      "laundry_v2",
      "-c",
      "CREATE TABLE recovery_probe(value text NOT NULL); INSERT INTO recovery_probe VALUES ('baseline');",
    ]),
  );
  await run([
    ...secureContainer,
    "--cap-add",
    "CHOWN",
    "--user",
    "0:0",
    "--mount",
    photoMount,
    "--entrypoint",
    "/usr/local/bin/node",
    fileImage,
    "-e",
    "const fs=require('node:fs');fs.chmodSync('/photos',0o700);fs.chownSync('/photos',10001,10001);",
  ]);
  await run(
    photoCommand(true, "/usr/local/bin/node", [
      "-e",
      "const fs=require('node:fs');fs.writeFileSync('/photos/.laundry-photo-store-v1','laundry-desk-photo-store:v1\\n',{mode:0o600});fs.writeFileSync('/photos/11111111-1111-4111-8111-111111111111.jpg','baseline-photo',{mode:0o600});",
    ]),
  );
  await validatePhotos();
  await dumpDatabase(databaseDump);
  await archivePhotos(photoArchive);
  await verifySet(databaseDump, photoArchive);
  const manifest = {
    version: 1,
    instance_id: `acceptance-${suffix}`,
    release: "real-container-acceptance",
    migration_head: "acceptance-probe",
    schema_sha256: "a".repeat(64),
    database: await fileRecord(databaseDump, "database.dump"),
    photos: await fileRecord(photoArchive, "photos.tar"),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { flag: "wx", mode: 0o600 });

  await run(
    databaseCommand("psql", [
      "-v",
      "ON_ERROR_STOP=1",
      "-d",
      "laundry_v2",
      "-c",
      "UPDATE recovery_probe SET value='mutated';",
    ]),
  );
  await run(
    photoCommand(true, "/usr/local/bin/node", [
      "-e",
      "const fs=require('node:fs');fs.writeFileSync('/photos/11111111-1111-4111-8111-111111111111.jpg','mutated-photo');fs.writeFileSync('/photos/22222222-2222-4222-8222-222222222222.jpg','extra-photo',{mode:0o600});",
    ]),
  );
  await dumpDatabase(safetyDump);
  await archivePhotos(safetyPhotos);
  await verifySet(safetyDump, safetyPhotos);
  await run(
    databaseCommand("pg_restore", [
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
      "--single-transaction",
      "--exit-on-error",
      "--dbname=laundry_v2",
    ]),
    { input: databaseDump },
  );
  await run(
    photoCommand(true, "/usr/local/bin/node", [
      "-e",
      "const fs=require('node:fs');for(const n of fs.readdirSync('/photos'))fs.rmSync('/photos/'+n,{recursive:true,force:false});",
    ]),
  );
  await run(
    photoCommand(true, "/bin/tar", [
      "--extract",
      "--file=-",
      "--directory=/photos",
      "--no-same-owner",
      "--no-same-permissions",
      "--delay-directory-restore",
    ]),
    { input: photoArchive, label: "PHOTO_RESTORE" },
  );
  await validatePhotos();
  const databaseValue = await run(
    databaseCommand("psql", ["-At", "-d", "laundry_v2", "-c", "SELECT value FROM recovery_probe;"]),
  );
  assert.equal(databaseValue.trim(), "baseline");
  const photoValue = await run(
    photoCommand(false, "/usr/local/bin/node", [
      "-e",
      "const fs=require('node:fs');process.stdout.write(fs.readFileSync('/photos/11111111-1111-4111-8111-111111111111.jpg'));if(fs.existsSync('/photos/22222222-2222-4222-8222-222222222222.jpg'))process.exit(23);",
    ]),
  );
  assert.equal(photoValue, "baseline-photo");
  for (const path of [databaseDump, photoArchive, safetyDump, safetyPhotos, manifestPath]) {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  const corruptDump = join(backups, "corrupt.dump");
  const corruptPhotos = join(backups, "corrupt.tar");
  await writeFile(corruptDump, Buffer.from("not-a-custom-dump"), { mode: 0o600 });
  await writeFile(corruptPhotos, Buffer.from("not-a-tar"), { mode: 0o600 });
  await assert.rejects(() => verifySet(corruptDump, photoArchive));
  await assert.rejects(() => verifySet(databaseDump, corruptPhotos));
  process.stdout.write(
    `RUNTIME_REAL_CONTAINER_RECOVERY_OK db=${manifest.database.sha256} photos=${manifest.photos.sha256}\n`,
  );
} finally {
  await run(["rm", "--force", postgresContainer], { accepting: [0, 1] });
  await run(["volume", "rm", "--force", databaseVolume], { accepting: [0, 1] });
  await run(["volume", "rm", "--force", photoVolume], { accepting: [0, 1] });
  await chmod(temporary, 0o700).catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
