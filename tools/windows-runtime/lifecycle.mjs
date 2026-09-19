import { randomUUID } from "node:crypto";
import { mkdir, rm, rename } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { inspectCompanion } from "./inspect-companion.mjs";
import { requireRealDirectory } from "./companion-files.mjs";
import { fail } from "./companion-contract.mjs";
import {
  exists,
  loadPlatform,
  readState,
  reference,
  requireCompatible,
  requireState,
  storage,
  withOperationLock,
} from "./lifecycle-storage.mjs";
import { stageRelease, verifyRelease, removeBoundPrograms } from "./lifecycle-release.mjs";
import { host, health, pgControl, startServer } from "./lifecycle-process.mjs";
import { runtimeEnvironment, cleanEnvironment } from "./lifecycle-environment.mjs";
import {
  initializeDatabase,
  initializeSecrets,
  kit,
  serverEnvironment,
} from "./lifecycle-database.mjs";

export const ACTIONS = Object.freeze([
  "install",
  "repair",
  "start",
  "stop",
  "upgrade",
  "rollback",
  "uninstall",
  "status",
]);
export function installationRoot() {
  if (!process.env.LOCALAPPDATA || !/^[A-Za-z]:\\/u.test(process.env.LOCALAPPDATA))
    fail("LOCALAPPDATA_INVALID");
  return resolve(process.env.LOCALAPPDATA, "laundry-desk-v2/runtime-companion");
}

export async function lifecycle(action, source, expectedDigest) {
  if (process.platform !== "win32" || process.arch !== "x64") fail("INSTALL_PLATFORM_INVALID");
  if (!ACTIONS.includes(action)) fail("ARGS_INVALID");
  source = resolve(source);
  const supplied = await inspectCompanion(source, expectedDigest);
  const platform = await loadPlatform(source);
  const io = storage(platform);
  const root = installationRoot();
  // A shared product parent may already belong to Counter/development Runtime.
  await requireRealDirectory(dirname(dirname(root)));
  if (!(await exists(dirname(root)))) await mkdir(dirname(root));
  await requireRealDirectory(dirname(root));
  // Lock before creating/inspecting mutable installation state.
  return withOperationLock(root, async () => {
    const existed = await exists(root);
    if (!existed && action !== "install") fail("NOT_INSTALLED");
    if (!existed) {
      const preflightEntry = reference(supplied, expectedDigest);
      if ((await host("task-inspect", root, source, preflightEntry.digest)).exists)
        fail("TASK_CONFLICT");
      const ports = await host("ports", root, source, expectedDigest);
      if (ports.api || ports.postgres) fail("PORT_CONFLICT");
    }
    if (action === "uninstall") {
      const within = relative(root, source);
      if (!within.startsWith("..") && !isAbsolute(within))
        fail("UNINSTALL_FROM_DISTRIBUTION_REQUIRED");
    }
    await io.directory(root);
    let state = await readState(io, root);
    const verified = new Map();
    async function verify(entry) {
      if (!verified.has(entry.digest)) verified.set(entry.digest, await verifyRelease(root, entry));
      return verified.get(entry.digest);
    }
    if (!state && existed) fail("UNOWNED_INSTALLATION");
    const save = async (next) => {
      await io.write(join(root, "state.json"), JSON.stringify(requireState(next)));
      state = next;
    };
    const task = async (verb, payload, entry) => {
      const controller = state?.controller ?? entry;
      const bound = state ? (await verify(controller)).payload : payload;
      return host(`task-${verb}`, root, bound, controller.digest);
    };
    async function stop(entry) {
      const { payload } = await verify(entry);
      await task("disable", payload, entry);
      const ports = await host("stop-server", root, payload, entry.digest);
      if (ports.postgres) await pgControl("stop", root, payload, cleanEnvironment());
      const after = await host("ports", root, payload, entry.digest);
      if (after.api || after.postgres) fail("STOP_INCOMPLETE");
      return payload;
    }
    async function verifyStopped(entry) {
      const { payload, manifest } = await verify(entry);
      const env = await runtimeEnvironment(root, payload, manifest, io);
      await pgControl("start", root, payload, env);
      try {
        await kit(payload, "verify", env, root);
      } finally {
        await pgControl("stop", root, payload, env);
      }
      return payload;
    }
    async function start(entry) {
      const { payload, manifest } = await verify(entry);
      const env = await runtimeEnvironment(root, payload, manifest, io);
      const ports = await host("ports", root, payload, entry.digest);
      if (ports.api && !ports.postgres) fail("PROCESS_STATE_INVALID");
      if (!ports.postgres) await pgControl("start", root, payload, env);
      try {
        await kit(payload, "verify", env, root);
        if (!ports.api) await startServer(root, payload, serverEnvironment(env));
        await health(root, payload, entry.digest);
        await save({ ...state, phase: "running" });
        await task("enable", payload, entry);
      } catch (error) {
        await stop(entry);
        await save({ ...state, phase: "stopped" });
        throw error;
      }
    }
    if (!state) {
      await io.directory(join(root, "releases"));
      await io.directory(join(root, "logs"));
      const staged = await stageRelease(root, source, expectedDigest, platform);
      const entry = reference(staged.manifest, expectedDigest);
      await save({
        schema: 1,
        assurance: "development_only",
        phase: "staged",
        current: entry,
        previous: null,
        controller: entry,
        pending: null,
        releases: [entry],
      });
      await initializeSecrets(root, io);
      await initializeDatabase(root, staged.payload, staged.manifest, io, platform);
      await save({ ...state, phase: "initialized" });
      await task("register", staged.payload, entry);
      await save({ ...state, phase: "stopped" });
      await start(entry);
    } else {
      if (state.phase === "staged") {
        if (action === "stop") {
          await stop(state.current);
          return { status: "staged", assurance: "development_only" };
        }
        fail("PARTIAL_INITIALIZATION");
      }
      if (state.pending) {
        requireCompatible(state.current, state.pending);
        await stop(state.pending);
        await save({ ...state, pending: null, phase: "stopped" });
      }
      if (action === "status") {
        if (state.phase !== "uninstalled") {
          const current = await verify(state.current);
          await task("inspect", current.payload, state.current);
          if (state.phase === "running") await health(root, current.payload, state.current.digest);
        }
      } else if (action === "uninstall") {
        if (state.phase !== "uninstalled") {
          const payload = await stop(state.current);
          await task("remove", payload, state.current);
          // Commit the recovery record before removing only manifest-bound program trees.
          await save({ ...state, phase: "uninstalled" });
        }
        for (const entry of state.releases) {
          const path = join(root, "releases", entry.digest);
          if (await exists(path)) {
            await removeBoundPrograms(root, entry, platform);
          }
        }
      } else if (state.phase === "uninstalled") {
        if (action !== "install" || expectedDigest !== state.current.digest)
          fail("REINSTALL_SAME_RELEASE_REQUIRED");
        await removeBoundPrograms(root, state.current, platform);
        // Only a checked manifest stub remains. Move it out of the publication path
        // before restoring a complete release; no database or secret is touched.
        const stub = join(root, "releases", expectedDigest);
        if (await exists(stub)) {
          const retired = join(root, "releases", `.uninstalled-${randomUUID()}`);
          await rename(stub, retired);
          await platform.flushDirectoryDurably(join(root, "releases"));
          await rm(retired, { recursive: true });
        }
        await stageRelease(root, source, expectedDigest, platform);
        await save({
          ...state,
          controller: state.current,
          previous: null,
          releases: [state.current],
        });
        const payload = await verifyStopped(state.current);
        await task("register", payload, state.current);
        await save({ ...state, previous: null, phase: "stopped" });
        await start(state.current);
      } else if (action === "stop") {
        await stop(state.current);
        await save({ ...state, phase: "stopped" });
      } else if (action === "start") {
        const current = await verify(state.current);
        await task("register", current.payload, state.current);
        await start(state.current);
      } else {
        const old = state.current;
        const next = action === "rollback" ? state.previous : reference(supplied, expectedDigest);
        if (!next) fail("ROLLBACK_UNAVAILABLE");
        requireCompatible(old, next);
        if (["install", "repair"].includes(action) && next.digest !== old.digest)
          fail("UPGRADE_REQUIRED");
        const retained = state.releases.some((entry) => entry.digest === next.digest);
        if (!retained && state.releases.length >= 16) fail("RELEASE_RETENTION_FULL");
        if (action === "rollback") await verify(next);
        else await stageRelease(root, source, expectedDigest, platform);
        if (!retained) await save({ ...state, releases: [...state.releases, next] });
        await stop(old);
        await save({ ...state, phase: "stopped" });
        const oldState = state;
        await save({ ...state, pending: next });
        const oldPayload = (await verify(old)).payload;
        try {
          const nextPayload = await verifyStopped(next);
          await task("register", nextPayload, next);
          await save({
            ...state,
            current: next,
            pending: null,
            previous: next.digest === old.digest ? state.previous : old,
            phase: "stopped",
          });
          await start(next);
        } catch (error) {
          // Do not infer commit failure: replacement may already be durable. Stop the
          // selected candidate before restoring the previous manifest-bound pointer.
          // Verification may have started PostgreSQL before its cleanup failed.
          // Keep pending intact until the candidate is confirmed stopped so a
          // later invocation can still identify and recover that process.
          await stop(next);
          await save(oldState);
          await task("register", oldPayload, old);
          await start(old);
          throw error;
        }
      }
    }
    return {
      status: state.phase,
      assurance: "development_only",
      source_git_sha: state.current.source,
      manifest_sha256: state.current.digest,
      migration_head: state.current.migrationHead,
    };
  });
}
