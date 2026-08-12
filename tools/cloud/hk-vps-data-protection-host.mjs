import { fail } from "./hk-vps-release-core.mjs";
import { runCloudCommand } from "./hk-vps-release-process.mjs";

const COMMAND_ENVIRONMENT = Object.freeze({
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
});

export async function readLaundryIdentity(signal, dependencies = {}) {
  const run = dependencies.runCloudCommand ?? runCloudCommand;
  const values = [];
  for (const [flag, label] of [
    ["-u", "CLOUD_DATA_LAUNDRY_UID"],
    ["-g", "CLOUD_DATA_LAUNDRY_GID"],
  ]) {
    const result = await run("/usr/bin/id", [flag, "laundry"], {
      cwd: "/",
      environment: COMMAND_ENVIRONMENT,
      label,
      signal,
      timeoutMs: 2 * 60_000,
    });
    if (!/^\d+\n?$/u.test(result.stdout)) fail("CLOUD_DATA_LAUNDRY_IDENTITY_INVALID");
    values.push(Number(result.stdout.trim()));
  }
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    fail("CLOUD_DATA_LAUNDRY_IDENTITY_INVALID");
  }
  return Object.freeze({ uid: values[0], gid: values[1] });
}
