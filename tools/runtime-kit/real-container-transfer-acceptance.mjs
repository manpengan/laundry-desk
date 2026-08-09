import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createPrivateKey, randomBytes, randomInt, sign } from "node:crypto";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadLanStaticAssets } from "../local/lan-gateway-core.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const kitRoot = join(repositoryRoot, "tools/runtime-kit");
const testApp = join(kitRoot, "dist/Laundry Desk Runtime Test.app");
const signingKey = join(kitRoot, "dist/test-signing-private.pem");
const runtimeExecutable = join(testApp, "Contents/MacOS/Laundry Desk Runtime");
const dockerfile = join(repositoryRoot, "apps/server/Dockerfile.runtime");
const migrationRoot = join(repositoryRoot, "packages/db/src/migrations");
const webRoot = join(repositoryRoot, "apps/web/dist-spa");
const commandEnvironment = Object.freeze({
  PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
});
const executableRoots = Object.freeze(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]);
const dockerCandidates = Object.freeze([
  "/Applications/Docker.app/Contents/Resources/bin/docker",
  ...executableRoots.map((root) => join(root, "docker")),
]);
const pnpmCandidates = Object.freeze(executableRoots.map((root) => join(root, "pnpm")));
const commandTimeoutMs = 2 * 60_000;
const buildTimeoutMs = 15 * 60_000;
const terminationGraceMs = 2_000;
const maximumOutputBytes = 2 * 1024 * 1024;
const photoName = "33333333-3333-4333-8333-333333333333.jpg";
async function firstExecutable(candidates, code) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through fixed installation paths.
    }
  }
  throw new Error(code);
}
function execute(file, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? commandTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > buildTimeoutMs) {
    throw new Error("RUNTIME_TRANSFER_TIMEOUT_INVALID");
  }
  const label = options.label ?? "COMMAND";
  return new Promise((resolveRun, rejectRun) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd: options.cwd ?? repositoryRoot,
        env: options.env ?? commandEnvironment,
        shell: false,
        stdio: options.visible ? ["pipe", "inherit", "inherit"] : ["pipe", "pipe", "pipe"],
      });
    } catch {
      rejectRun(new Error(`${label}_FAILED`));
      return;
    }
    const stdout = [];
    const stderr = [];
    let bytes = 0,
      outputExceeded = false,
      settled = false,
      timedOut = false,
      terminationTimer,
      finalTimer,
      timeoutTimer;
    const onStdout = (chunk) => {
      bytes += chunk.byteLength;
      if (bytes <= maximumOutputBytes) stdout.push(chunk);
      else outputExceeded = true;
    };
    const onStderr = (chunk) => {
      bytes += chunk.byteLength;
      if (bytes <= maximumOutputBytes) stderr.push(chunk);
      else outputExceeded = true;
    };
    const onStdinError = () => undefined;
    const cleanup = () => {
      for (const timer of [timeoutTimer, terminationTimer, finalTimer]) clearTimeout(timer);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      child.stdin.removeListener("error", onStdinError);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      error === undefined ? resolveRun(value) : rejectRun(error);
    };
    const kill = (signal) => {
      try {
        child.kill(signal);
      } catch {
        // A bounded final timer still settles with the stable timeout code.
      }
    };
    const onError = () => {
      if (!timedOut) finish(new Error(`${label}_FAILED`));
    };
    const onClose = (code) => {
      if (timedOut) {
        finish(new Error(`${label}_TIMEOUT`));
        return;
      }
      if (outputExceeded) {
        finish(new Error("RUNTIME_TRANSFER_OUTPUT_TOO_LARGE"));
        return;
      }
      const result = Object.freeze({
        code: code ?? 1,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
      if (!(options.accepting ?? [0]).includes(result.code)) {
        finish(new Error(`${label}_FAILED`));
      } else finish(undefined, result);
    };
    child.once("error", onError);
    child.once("close", onClose);
    child.stdin.on("error", onStdinError);
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminationTimer = setTimeout(() => {
        kill("SIGKILL");
        finalTimer = setTimeout(() => finish(new Error(`${label}_TIMEOUT`)), terminationGraceMs);
      }, terminationGraceMs);
      kill("SIGTERM");
    }, timeoutMs);
    child.stdin.end(options.input ?? "");
  });
}
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
};
async function migrationBundle() {
  const names = (await readdir(migrationRoot))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort();
  assert.ok(names.length > 0);
  const records = [];
  for (const name of names) {
    records.push(`${name}\0${sha256(await readFile(join(migrationRoot, name)))}\n`);
  }
  return Object.freeze({ head: names.at(-1), sha256: sha256(records.join("")) });
}
async function writeManifest(path, payload) {
  const key = createPrivateKey(await readFile(signingKey));
  const signature = sign(null, Buffer.from(JSON.stringify(canonical(payload))), key).toString(
    "base64url",
  );
  await writeFile(path, JSON.stringify({ payload, signature }), { flag: "wx", mode: 0o600 });
}

const randomSetup = () => {
  const adminPin = String(randomInt(100_000, 1_000_000));
  let approverPin = String(randomInt(100_000, 1_000_000));
  while (approverPin === adminPin) approverPin = String(randomInt(100_000, 1_000_000));
  return Object.freeze({
    adminUsername: "owner",
    adminDisplayName: "真实源店长",
    adminPassword: `admin-${randomBytes(24).toString("base64url")}`,
    adminPin,
    approverUsername: "approver",
    approverDisplayName: "真实复核管理员",
    approverPassword: `approver-${randomBytes(24).toString("base64url")}`,
    approverPin,
  });
};

const exactRuntimeCode = (result, expected) => {
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `${expected}\n`);
};

const assertRuntimeSuccess = (result, failureCode) => {
  if (result.code !== 0) {
    const fixedCode = /^RUNTIME_[A-Z0-9_]+\n$/u.test(result.stderr)
      ? result.stderr.trim()
      : "RUNTIME_NONCANONICAL_ERROR";
    assert.fail(`${failureCode}:${fixedCode}`);
  }
  assert.equal(result.stderr, "", failureCode);
};

export async function runRealContainerTransferAcceptance() {
  const orchestrated = process.argv.length === 3 && process.argv[2] === "--orchestrated";
  if (process.argv.length !== 2 && !orchestrated)
    throw new Error("RUNTIME_TRANSFER_ACCEPTANCE_ARGS_INVALID");
  const docker = await firstExecutable(dockerCandidates, "RUNTIME_TRANSFER_DOCKER_UNAVAILABLE");
  const pnpm = await firstExecutable(pnpmCandidates, "RUNTIME_TRANSFER_PNPM_UNAVAILABLE");
  const token = randomBytes(6).toString("hex");
  const sourceID = `${token}s`;
  const destinationID = `${token}d`;
  const project = (id) => `laundry-desk-runtime-test-${id}`;
  const volume = (id, name) => `${project(id)}_${name}`;
  const sourceProject = project(sourceID);
  const destinationProject = project(destinationID);
  const sourceTag = `laundry-runtime-data-test-${sourceID}:local`;
  const destinationTag = `laundry-runtime-data-test-${destinationID}:local`;
  const acceptanceLabel = `laundry-data-${token}`;
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "laundry-runtime-real-transfer-")));
  const sourceRoot = join(temporary, "source-runtime");
  const destinationRoot = join(temporary, "destination-runtime");
  const manifestPath = join(temporary, "runtime-manifest.json");
  const transferPath = join(temporary, "store-move.laundry-transfer");
  const corruptedTransferPath = join(temporary, "corrupt.laundry-transfer");
  const transferPassword = `transfer-${randomBytes(24).toString("base64url")}`;
  const sourceSetup = randomSetup();
  const destinationSetup = randomSetup();
  let invocationRecords = [];
  let runtimeOutputs = [];
  let proof;

  const dockerRun = (args, options = {}) =>
    execute(docker, args, { ...options, label: options.label ?? "DOCKER" });
  const inspectPostgresDigest = async () => {
    const result = await dockerRun(
      ["image", "inspect", "--format", "{{json .RepoDigests}}", "postgres:16"],
      { accepting: [0, 1], label: "POSTGRES_IMAGE_INSPECT" },
    );
    if (result.code !== 0) return undefined;
    let digests;
    try {
      digests = JSON.parse(result.stdout);
    } catch {
      return undefined;
    }
    const digest = Array.isArray(digests)
      ? digests.find(
          (entry) => typeof entry === "string" && /^postgres@sha256:[0-9a-f]{64}$/u.test(entry),
        )
      : undefined;
    return digest?.replace("postgres@", "docker.io/library/postgres@");
  };
  const runtimeRun = async (root, id, image, args, input = "") => {
    const runtimeArgs = [
      "--test-system-config-root",
      root,
      "--test-runtime-id",
      id,
      "--test-local-server-image",
      image,
      ...args,
    ];
    invocationRecords = [
      ...invocationRecords,
      Object.freeze({ arguments: runtimeArgs, environment: commandEnvironment }),
    ];
    const result = await execute(runtimeExecutable, runtimeArgs, {
      accepting: [0, 1],
      env: commandEnvironment,
      input,
      label: "RUNTIME_TRANSFER_CLI",
      timeoutMs: buildTimeoutMs,
    });
    runtimeOutputs = [...runtimeOutputs, result.stdout, result.stderr];
    return result;
  };
  const state = async (root) => JSON.parse(await readFile(join(root, "state.json"), "utf8"));
  const labelledIDs = async (kind, runtimeProject, service) => {
    const listArgs =
      kind === "container" ? ["container", "ls", "--all", "--quiet"] : ["network", "ls", "--quiet"];
    const serviceFilter =
      service === undefined ? [] : ["--filter", `label=com.docker.compose.service=${service}`];
    const output = (
      await dockerRun(
        [
          ...listArgs,
          "--filter",
          `label=com.docker.compose.project=${runtimeProject}`,
          ...serviceFilter,
        ],
        { accepting: [0, 1], label: `RUNTIME_${kind.toUpperCase()}_LIST` },
      )
    ).stdout.trim();
    const ids = output === "" ? [] : output.split("\n");
    assert.ok(ids.every((id) => /^[0-9a-f]{12,64}$/u.test(id)));
    return ids;
  };
  const containerID = async (runtimeProject, service) => {
    const ids = await labelledIDs("container", runtimeProject, service);
    assert.equal(ids.length, 1);
    return ids[0];
  };
  const seed = async (runtimeProject, value, photo) => {
    assert.match(value, /^(?:source|destination)-row$/u);
    const postgres = await containerID(runtimeProject, "postgres");
    const server = await containerID(runtimeProject, "server");
    const photoBytes = Buffer.byteLength(photo),
      photoDigest = sha256(photo);
    const sql =
      "WITH context AS (SELECT org_id,store_id,admin_staff_id FROM public.local_bootstrap_metadata WHERE singleton), customer AS (" +
      "INSERT INTO public.customers (id,org_id,phone,name,note,created_at,updated_at) SELECT '44444444-4444-4444-8444-444444444444'::uuid,org_id," +
      `'13900000001','${value}','runtime_transfer_acceptance',NOW(),NOW() FROM context ` +
      "ON CONFLICT (org_id,phone) DO UPDATE SET name=EXCLUDED.name,note=EXCLUDED.note,updated_at=EXCLUDED.updated_at RETURNING org_id,id), ordered AS (" +
      "INSERT INTO public.orders (id,org_id,store_id,ticket_no,status,customer_phone," +
      "customer_name,note,subtotal_cents,payable_cents,paid_cents,balance_cents,created_at,updated_at,created_by_staff_id,business_date,customer_id) SELECT " +
      "'55555555-5555-4555-8555-555555555555'::uuid,c.org_id,x.store_id,'ACCEPT-1','open','13900000001'," +
      `'${value}','runtime_transfer_acceptance',0,0,0,0,NOW(),NOW(),` +
      "x.admin_staff_id,'2026-08-08',c.id FROM context x JOIN customer c USING (org_id) " +
      "RETURNING org_id,store_id,id), lined AS (INSERT INTO public.order_lines " +
      "(id,org_id,store_id,order_id,line_index,service_code,category_code,unit_price_cents,qty,line_total_cents) SELECT " +
      "'66666666-6666-4666-8666-666666666666'::uuid,org_id,store_id,id,0," +
      "'wash','shirt',0,1,0 FROM ordered RETURNING org_id,store_id,order_id,id), " +
      "garmented AS (INSERT INTO public.garments (id,org_id,store_id,order_id,order_line_id,seq,barcode,service_code,category_code,unit_price_cents,status) " +
      "SELECT '77777777-7777-4777-8777-777777777777'::uuid,org_id,store_id," +
      "order_id,id,1,'ACCEPT-GARMENT','wash','shirt',0,'received' FROM lined " +
      "RETURNING org_id,store_id,order_id,id) INSERT INTO public.garment_photos " +
      "(id,org_id,store_id,garment_id,order_id,kind,storage_key,content_type,byte_size,content_sha256,taken_at,created_by_staff_id) SELECT " +
      "'88888888-8888-4888-8888-888888888888'::uuid,g.org_id,g.store_id,g.id," +
      `g.order_id,'receive','${photoName}','image/jpeg',${photoBytes},'${photoDigest}',` +
      "NOW(),x.admin_staff_id FROM garmented g JOIN context x USING (org_id,store_id);";
    await dockerRun([
      "exec",
      "--user",
      "postgres",
      postgres,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-d",
      "laundry_v2",
      "-c",
      sql,
    ]);
    await dockerRun([
      "exec",
      server,
      "/usr/local/bin/node",
      "-e",
      `require('node:fs').writeFileSync('/var/lib/laundry/photos/${photoName}',${JSON.stringify(photo)},{mode:0o600})`,
    ]);
  };
  const databaseValue = async (runtimeProject) => {
    const postgres = await containerID(runtimeProject, "postgres");
    return (
      await dockerRun([
        "exec",
        "--user",
        "postgres",
        postgres,
        "psql",
        "-At",
        "-d",
        "laundry_v2",
        "-c",
        "SELECT name FROM public.customers WHERE phone='13900000001' " + "ORDER BY org_id LIMIT 1;",
      ])
    ).stdout.trim();
  };
  const photoHash = async (runtimeProject) => {
    const server = await containerID(runtimeProject, "server");
    return (
      await dockerRun([
        "exec",
        server,
        "/usr/local/bin/node",
        "-e",
        `const c=require('node:crypto'),f=require('node:fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync('/var/lib/laundry/photos/${photoName}')).digest('hex'))`,
      ])
    ).stdout.trim();
  };
  const stopProject = async (runtimeProject) => {
    const containers = await labelledIDs("container", runtimeProject);
    if (containers.length > 0) {
      await dockerRun(["container", "rm", "--force", ...containers], {
        accepting: [0, 1],
        label: "RUNTIME_PROJECT_CONTAINER_REMOVE",
      });
    }
    const networks = await labelledIDs("network", runtimeProject);
    if (networks.length > 0) {
      await dockerRun(["network", "rm", ...networks], {
        accepting: [0, 1],
        label: "RUNTIME_PROJECT_NETWORK_REMOVE",
      });
    }
  };

  try {
    if (!orchestrated) {
      await execute(process.execPath, [join(kitRoot, "build-app.mjs"), "--testing"], {
        label: "RUNTIME_APP_BUILD",
        timeoutMs: buildTimeoutMs,
        visible: true,
      });
    }
    await execute(process.execPath, [join(kitRoot, "inspect-app.mjs"), testApp], {
      label: "RUNTIME_APP_INSPECT",
    });
    await execute(pnpm, ["--filter", "@laundry/ui", "build"], {
      label: "RUNTIME_UI_BUILD",
      timeoutMs: buildTimeoutMs,
      visible: true,
    });
    await execute(pnpm, ["--filter", "@laundry/web", "build"], {
      label: "RUNTIME_WEB_BUILD",
      timeoutMs: buildTimeoutMs,
      visible: true,
    });

    const migrations = await migrationBundle();
    const contractsSHA = sha256(
      await readFile(join(repositoryRoot, "packages/contracts/openapi/laundry-v2.openapi.json")),
    );
    const schemaSHA = sha256(await readFile(join(repositoryRoot, "packages/db/src/README.md")));
    const ownerSpaSHA = (await loadLanStaticAssets(webRoot)).sha256;
    const release = "0.1.0-stage3";
    let postgresDigest = await inspectPostgresDigest();
    if (postgresDigest === undefined) {
      await dockerRun(["pull", "postgres:16"], {
        label: "POSTGRES_PULL",
        timeoutMs: buildTimeoutMs,
        visible: true,
      });
      postgresDigest = await inspectPostgresDigest();
    }
    assert.match(postgresDigest, /^docker\.io\/library\/postgres@sha256:[0-9a-f]{64}$/u);
    await dockerRun(
      [
        "build",
        "--file",
        dockerfile,
        "--tag",
        sourceTag,
        "--label",
        `com.laundry-desk.acceptance=${acceptanceLabel}`,
        "--build-arg",
        `RUNTIME_RELEASE=${release}`,
        "--build-arg",
        "RUNTIME_CONTRACTS_MAJOR=2",
        "--build-arg",
        `RUNTIME_CONTRACTS_SHA256=${contractsSHA}`,
        "--build-arg",
        `RUNTIME_SERVER_VERSION=${release}`,
        "--build-arg",
        `RUNTIME_WEB_BUNDLE_SHA256=${ownerSpaSHA}`,
        "--build-arg",
        `RUNTIME_SCHEMA_SHA256=${schemaSHA}`,
        "--build-arg",
        `RUNTIME_MIGRATIONS_SHA256=${migrations.sha256}`,
        "--build-arg",
        `RUNTIME_MIGRATION_HEAD=${migrations.head}`,
        repositoryRoot,
      ],
      { label: "RUNTIME_SERVER_IMAGE_BUILD", timeoutMs: buildTimeoutMs, visible: true },
    );
    await dockerRun(["tag", sourceTag, destinationTag]);
    const imageID = (
      await dockerRun(["image", "inspect", "--format", "{{.Id}}", sourceTag])
    ).stdout.trim();
    assert.match(imageID, /^sha256:[0-9a-f]{64}$/u);
    const resources = join(testApp, "Contents/Resources");
    const compose = await readFile(join(resources, "docker-compose.runtime.yml"));
    const lanCompose = await readFile(join(resources, "docker-compose.runtime-lan.yml"));
    const payload = Object.freeze({
      schema_version: 2,
      product: "laundry-desk-runtime",
      release,
      contracts_major: 2,
      contracts_sha256: contractsSHA,
      server_version: release,
      web_bundle_sha256: ownerSpaSHA,
      minimum_app_version: "0.1.0",
      database_schema_sha256: schemaSHA,
      migrations_sha256: migrations.sha256,
      migration_head: migrations.head,
      maximum_compatible_schema: migrations.head,
      rollback_target: null,
      compose_sha256: sha256(compose),
      lan_compose_sha256: sha256(lanCompose),
      owner_spa_sha256: ownerSpaSHA,
      server_image: Object.freeze({
        index: `registry.example/laundry/server@${imageID}`,
        linux_arm64: imageID,
        linux_amd64: imageID,
      }),
      postgres_major: 16,
      postgres_image: postgresDigest,
    });
    await writeManifest(manifestPath, payload);

    let result = await runtimeRun(
      sourceRoot,
      sourceID,
      sourceTag,
      ["install", "--manifest", manifestPath],
      JSON.stringify(sourceSetup),
    );
    assertRuntimeSuccess(result, "RUNTIME_REAL_SOURCE_INSTALL_FAILED");
    const sourceInstance = (await state(sourceRoot)).instance_id;
    await seed(sourceProject, "source-row", "source-photo");
    const expectedDatabase = await databaseValue(sourceProject);
    const expectedPhoto = await photoHash(sourceProject);
    result = await runtimeRun(sourceRoot, sourceID, sourceTag, ["backup", "create"]);
    assertRuntimeSuccess(result, "RUNTIME_REAL_SOURCE_BACKUP_FAILED");
    const backup = JSON.parse(result.stdout);

    const backupRoot = join(sourceRoot, "backups", backup.backup_id);
    for (const name of ["database.dump", "photos.tar", "manifest.json"]) {
      const path = join(backupRoot, name);
      const original = await readFile(path);
      await writeFile(path, "corrupt", { mode: 0o600 });
      const rejectedPath = join(temporary, `rejected-${name}.laundry-transfer`);
      result = await runtimeRun(
        sourceRoot,
        sourceID,
        sourceTag,
        ["transfer", "export"],
        JSON.stringify({
          backup_id: backup.backup_id,
          password: transferPassword,
          path: rejectedPath,
        }),
      );
      exactRuntimeCode(result, "RUNTIME_BACKUP_INVALID");
      await assert.rejects(() => stat(rejectedPath), { code: "ENOENT" });
      await writeFile(path, original, { mode: 0o600 });
    }

    result = await runtimeRun(
      sourceRoot,
      sourceID,
      sourceTag,
      ["transfer", "export"],
      JSON.stringify({
        backup_id: backup.backup_id,
        password: transferPassword,
        path: transferPath,
      }),
    );
    assertRuntimeSuccess(result, "RUNTIME_REAL_EXPORT_FAILED");
    const exported = JSON.parse(result.stdout);
    const transfer = await readFile(transferPath);
    assert.equal(exported.bytes, transfer.length);
    assert.equal(exported.sha256, sha256(transfer));
    assert.equal(transfer.includes(Buffer.from(transferPassword)), false);
    result = await runtimeRun(sourceRoot, sourceID, sourceTag, ["stop"]);
    assertRuntimeSuccess(result, "RUNTIME_REAL_SOURCE_STOP_FAILED");
    await stopProject(sourceProject);

    result = await runtimeRun(
      destinationRoot,
      destinationID,
      destinationTag,
      ["install", "--manifest", manifestPath],
      JSON.stringify(destinationSetup),
    );
    assertRuntimeSuccess(result, "RUNTIME_REAL_DESTINATION_INSTALL_FAILED");
    const destinationInstance = (await state(destinationRoot)).instance_id;
    assert.notEqual(destinationInstance, sourceInstance);
    await seed(destinationProject, "destination-row", "destination-photo");
    const destinationPhoto = await photoHash(destinationProject);

    const corruptTransfer = Buffer.from(transfer);
    corruptTransfer[corruptTransfer.length - 1] ^= 1;
    await writeFile(corruptedTransferPath, corruptTransfer, {
      flag: "wx",
      flush: true,
      mode: 0o600,
    });
    const corruptedMetadata = await stat(corruptedTransferPath);
    assert.equal(corruptedMetadata.mode & 0o777, 0o600);
    assert.equal(corruptedMetadata.nlink, 1);
    assert.equal(corruptedMetadata.size, transfer.length);
    result = await runtimeRun(
      destinationRoot,
      destinationID,
      destinationTag,
      ["transfer", "inspect"],
      JSON.stringify({ password: transferPassword, path: corruptedTransferPath }),
    );
    exactRuntimeCode(result, "RUNTIME_TRANSFER_INVALID");
    assert.equal(await databaseValue(destinationProject), "destination-row");
    assert.equal(await photoHash(destinationProject), destinationPhoto);

    result = await runtimeRun(
      destinationRoot,
      destinationID,
      destinationTag,
      ["transfer", "inspect"],
      JSON.stringify({ password: transferPassword, path: transferPath }),
    );
    assertRuntimeSuccess(result, "RUNTIME_REAL_INSPECT_FAILED");
    const inspected = JSON.parse(result.stdout);
    assert.equal(inspected.compatible, true);
    assert.equal(inspected.source_instance_id, sourceInstance);
    result = await runtimeRun(
      destinationRoot,
      destinationID,
      destinationTag,
      ["transfer", "import"],
      JSON.stringify({
        confirmation: inspected.confirmation,
        password: transferPassword,
        path: transferPath,
      }),
    );
    assertRuntimeSuccess(result, "RUNTIME_REAL_IMPORT_FAILED");
    const imported = JSON.parse(result.stdout);
    assert.equal(await databaseValue(destinationProject), expectedDatabase);
    assert.equal(await photoHash(destinationProject), expectedPhoto);
    assert.equal((await state(destinationRoot)).instance_id, destinationInstance);

    result = await runtimeRun(destinationRoot, destinationID, destinationTag, ["backup", "list"]);
    assertRuntimeSuccess(result, "RUNTIME_REAL_SAFETY_LIST_FAILED");
    const safety = JSON.parse(result.stdout).backups.find(
      (entry) => entry.backup_id === imported.safety_backup_id,
    );
    assert.equal(safety.kind, "pre_transfer");
    assert.equal(safety.verified, true);
    result = await runtimeRun(
      destinationRoot,
      destinationID,
      destinationTag,
      ["backup", "restore"],
      JSON.stringify({ backup_id: safety.backup_id, confirmation: safety.confirmation }),
    );
    assertRuntimeSuccess(result, "RUNTIME_REAL_PRE_TRANSFER_RESTORE_FAILED");
    assert.equal(await databaseValue(destinationProject), "destination-row");
    assert.equal(await photoHash(destinationProject), destinationPhoto);
    assert.equal((await state(destinationRoot)).instance_id, destinationInstance);

    const secretPattern = new RegExp(
      [
        transferPassword,
        sourceSetup.adminPassword,
        sourceSetup.approverPassword,
        destinationSetup.adminPassword,
        destinationSetup.approverPassword,
      ].join("|"),
      "u",
    );
    assert.doesNotMatch(JSON.stringify(invocationRecords), secretPattern);
    assert.doesNotMatch(runtimeOutputs.join("\n"), secretPattern);
    proof = Object.freeze({ database: expectedDatabase, photo: expectedPhoto });
  } finally {
    for (const [id, runtimeProject] of [
      [sourceID, sourceProject],
      [destinationID, destinationProject],
    ]) {
      await stopProject(runtimeProject).catch(() => undefined);
      const containers = (
        await dockerRun(
          [
            "container",
            "ls",
            "--all",
            "--quiet",
            "--filter",
            `label=com.docker.compose.project=${runtimeProject}`,
          ],
          { accepting: [0, 1], label: "CLEANUP_CONTAINER_LIST" },
        ).catch(() => ({ stdout: "" }))
      ).stdout.trim();
      if (containers !== "") {
        const ids = containers.split("\n");
        assert.ok(ids.every((id) => /^[0-9a-f]{12,64}$/u.test(id)));
        await dockerRun(["container", "rm", "--force", ...ids], {
          accepting: [0, 1],
          label: "CLEANUP_CONTAINER_REMOVE",
        });
      }
      const networks = (
        await dockerRun(
          [
            "network",
            "ls",
            "--quiet",
            "--filter",
            `label=com.docker.compose.project=${runtimeProject}`,
          ],
          { accepting: [0, 1], label: "CLEANUP_NETWORK_LIST" },
        ).catch(() => ({ stdout: "" }))
      ).stdout.trim();
      if (networks !== "") {
        const ids = networks.split("\n");
        assert.ok(ids.every((id) => /^[0-9a-f]{12,64}$/u.test(id)));
        await dockerRun(["network", "rm", ...ids], {
          accepting: [0, 1],
          label: "CLEANUP_NETWORK_REMOVE",
        });
      }
      for (const name of [volume(id, "pgdata-v2"), volume(id, "photos")]) {
        await dockerRun(["volume", "rm", "--force", name], {
          accepting: [0, 1],
          label: "CLEANUP_VOLUME_REMOVE",
        });
      }
    }
    const labels = (
      await dockerRun(["image", "inspect", "--format", "{{json .Config.Labels}}", sourceTag], {
        accepting: [0, 1],
        label: "CLEANUP_IMAGE_INSPECT",
      }).catch(() => ({ stdout: "" }))
    ).stdout.trim();
    if (labels !== "" && JSON.parse(labels)?.["com.laundry-desk.acceptance"] === acceptanceLabel) {
      await dockerRun(["image", "rm", "--force", sourceTag, destinationTag], {
        accepting: [0, 1],
        label: "CLEANUP_IMAGE_REMOVE",
      });
    }
    await chmod(temporary, 0o700).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
    await rm(signingKey, { force: true });

    for (const runtimeProject of [sourceProject, destinationProject]) {
      for (const [kind, args] of [
        [
          "containers",
          [
            "container",
            "ls",
            "--all",
            "--quiet",
            "--filter",
            `label=com.docker.compose.project=${runtimeProject}`,
          ],
        ],
        [
          "networks",
          [
            "network",
            "ls",
            "--quiet",
            "--filter",
            `label=com.docker.compose.project=${runtimeProject}`,
          ],
        ],
      ]) {
        assert.equal(
          (await dockerRun(args, { label: `CLEANUP_${kind.toUpperCase()}_VERIFY` })).stdout.trim(),
          "",
        );
      }
    }
    for (const id of [sourceID, destinationID]) {
      for (const name of [volume(id, "pgdata-v2"), volume(id, "photos")]) {
        assert.equal(
          (
            await dockerRun(["volume", "inspect", name], {
              accepting: [0, 1],
              label: "CLEANUP_VOLUME_VERIFY",
            })
          ).code,
          1,
        );
      }
    }
    for (const tag of [sourceTag, destinationTag]) {
      assert.equal(
        (
          await dockerRun(["image", "inspect", tag], {
            accepting: [0, 1],
            label: "CLEANUP_IMAGE_VERIFY",
          })
        ).code,
        1,
      );
    }
  }

  assert.ok(proof);
  process.stdout.write(
    `RUNTIME_REAL_CONTAINER_TRANSFER_OK db=${sha256(proof.database)} photos=${proof.photo} roots=2 cleanup=clean\n`,
  );
}

const invoked = process.argv[1];
if (invoked !== undefined && pathToFileURL(resolve(invoked)).href === import.meta.url) {
  await runRealContainerTransferAcceptance();
}
