import { spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const requested = process.argv.slice(2);
if (requested.some((value) => !["browser", "mac", "pg"].includes(value))) {
  throw new Error("COMMISSIONING_ACCEPTANCE_ARGS_INVALID");
}
const modes = requested.length === 0 ? ["browser", "mac"] : requested;
const acceptanceTempRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();

const generatedSetup = () => {
  const adminPin = String(randomInt(100_000, 1_000_000));
  let approverPin = String(randomInt(100_000, 1_000_000));
  while (approverPin === adminPin) approverPin = String(randomInt(100_000, 1_000_000));
  return Object.freeze({
    LAUNDRY_LOCAL_ORG_CODE: "local",
    LAUNDRY_LOCAL_STORE_CODE: "main",
    LAUNDRY_BOOTSTRAP_ADMIN_USERNAME: "owner",
    LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME: "Local Owner",
    LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD: randomBytes(32).toString("base64url"),
    LAUNDRY_BOOTSTRAP_ADMIN_PIN: adminPin,
    LAUNDRY_BOOTSTRAP_APPROVER_USERNAME: "approver",
    LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME: "Approval Administrator",
    LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD: randomBytes(32).toString("base64url"),
    LAUNDRY_BOOTSTRAP_APPROVER_PIN: approverPin,
  });
};

const run = (file, args, environment, accepting = new Set([0])) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(file, args, {
      cwd: process.cwd(),
      env: environment,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (accepting.has(code ?? 1)) resolveRun(code ?? 1);
      else rejectRun(new Error("COMMISSIONING_ACCEPTANCE_COMMAND_FAILED"));
    });
  });

const capture = (file, args, environment, accepting = new Set([0])) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(file, args, {
      cwd: process.cwd(),
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (accepting.has(code ?? 1)) resolveRun({ code: code ?? 1, stdout: Buffer.concat(chunks) });
      else rejectRun(new Error("COMMISSIONING_ACCEPTANCE_COMMAND_FAILED"));
    });
  });

const cleanup = async ({ project, configRoot, userDataRoot, environment }) => {
  const failures = [];
  try {
    await run(process.execPath, ["tools/local/down.mjs"], environment);
  } catch (error) {
    failures.push(error);
  }
  try {
    const volume = `${project}_pgdata-v2`;
    const inspected = await capture(
      "docker",
      ["volume", "inspect", "--format", "{{json .Labels}}", volume],
      environment,
      new Set([0, 1]),
    );
    if (inspected.code === 0) {
      const labels = JSON.parse(inspected.stdout.toString("utf8"));
      if (
        labels?.["com.laundry-desk.managed"] !== "true" ||
        labels?.["com.laundry-desk.project"] !== project
      ) {
        throw new Error("COMMISSIONING_ACCEPTANCE_VOLUME_UNOWNED");
      }
      await run("docker", ["volume", "rm", volume], environment);
    }
  } catch (error) {
    failures.push(error);
  } finally {
    for (const root of [configRoot, userDataRoot].filter(Boolean)) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "COMMISSIONING_ACCEPTANCE_CLEANUP_FAILED");
  }
};

for (const mode of modes) {
  const suffix = randomBytes(4).toString("hex");
  const project = `laundry-commission-${mode}-${suffix}`;
  const configRoot = await mkdtemp(join(acceptanceTempRoot, `laundry-${mode}-config-`));
  const userDataRoot =
    mode === "mac" ? await mkdtemp(join(acceptanceTempRoot, "laundry-mac-user-data-")) : undefined;
  const environment = {
    ...process.env,
    ...generatedSetup(),
    COMPOSE_PROJECT_NAME: project,
    LAUNDRY_LOCAL_CONFIG_DIR: configRoot,
    ...(mode === "browser" ? { LAUNDRY_NOTIFICATION_PROVIDER_MODE: "software_only" } : {}),
    ...(userDataRoot === undefined
      ? {}
      : {
          LAUNDRY_MAC_APP_PATH: resolve(
            "apps/edge-agent/release",
            process.arch === "arm64" ? "mac-arm64" : "mac",
            "laundry-desk V2.app",
          ),
          LAUNDRY_MAC_USER_DATA_DIR: userDataRoot,
        }),
  };
  try {
    if (mode === "pg") {
      // The PostgreSQL acceptance runners execute compiled Node tests on the
      // host, so make their dist tree part of this self-contained gate.
      await run("pnpm", ["--filter", "@laundry/server", "build"], environment);
    }
    await run(process.execPath, ["tools/local/up.mjs", "--bootstrap"], environment);
    await run(process.execPath, ["tools/local/commissioning-proof.mjs"], environment);
    if (mode === "pg") {
      await run(
        "docker",
        ["compose", "-p", project, "-f", "tools/compose/docker-compose.yml", "stop", "server"],
        environment,
      );
      await run(process.execPath, ["tools/local/commissioning-pg-acceptance.mjs"], {
        ...environment,
        LAUNDRY_COMMISSIONING_ACCEPTANCE_ISOLATED: "1",
      });
      await run(process.execPath, ["tools/local/delivery-policy-pg-acceptance.mjs"], {
        ...environment,
        LAUNDRY_COMMISSIONING_ACCEPTANCE_ISOLATED: "1",
      });
      await run(process.execPath, ["tools/local/member-benefits-pg-acceptance.mjs"], {
        ...environment,
        LAUNDRY_COMMISSIONING_ACCEPTANCE_ISOLATED: "1",
      });
      await run(process.execPath, ["tools/local/customer-profile-pg-acceptance.mjs"], {
        ...environment,
        LAUNDRY_COMMISSIONING_ACCEPTANCE_ISOLATED: "1",
      });
      await run(process.execPath, ["tools/local/notification-delivery-pg-acceptance.mjs"], {
        ...environment,
        LAUNDRY_COMMISSIONING_ACCEPTANCE_ISOLATED: "1",
      });
      await run(process.execPath, ["tools/local/factory-handoff-pg-acceptance.mjs"], {
        ...environment,
        LAUNDRY_COMMISSIONING_ACCEPTANCE_ISOLATED: "1",
      });
      await run(process.execPath, ["tools/cloud/hk-vps-release-catalog-pg-acceptance.mjs"], {
        ...environment,
        LAUNDRY_CLOUD_RELEASE_PG_TEST: "1",
        LAUNDRY_USE_LOCAL_PG: "1",
      });
      await run(process.execPath, ["tools/cloud/hk-vps-data-protection-pg-acceptance.mjs"], {
        ...environment,
        LAUNDRY_COMMISSIONING_ACCEPTANCE_ISOLATED: "1",
        LAUNDRY_CLOUD_DATA_PG_TEST: "1",
        LAUNDRY_USE_LOCAL_PG: "1",
      });
      await run(process.execPath, ["tools/local/up.mjs"], environment);
      await run(process.execPath, ["tools/local/commissioning-proof.mjs"], environment);
    } else if (mode === "browser") {
      await run("pnpm", ["local:web:commissioning:e2e"], environment);
      await run(
        "pnpm",
        [
          "exec",
          "playwright",
          "test",
          "-c",
          "apps/web/playwright.local.config.ts",
          "member-benefits.spec.ts",
          "customer-profile.spec.ts",
          "notification-delivery.spec.ts",
          "factory-handoff.spec.ts",
          "--workers=1",
        ],
        environment,
      );
    } else {
      await run("pnpm", ["local:mac:commissioning:e2e"], environment);
    }
  } finally {
    await cleanup({ project, configRoot, userDataRoot, environment });
  }
}

process.stdout.write(`LOCAL_FRESH_COMMISSIONING_ACCEPTANCE_OK modes=${modes.join(",")}\n`);
