import {
  RuntimeCounterAcceptanceError,
  assertSecretsNotExposed,
  fail,
} from "./runtime-counter-loopback-core.mjs";
import { monitorElectronOutput } from "./runtime-counter-loopback-probes.mjs";

function withDeadline(promise, duration, code) {
  return new Promise((resolveDeadline, rejectDeadline) => {
    const timer = setTimeout(
      () => rejectDeadline(new RuntimeCounterAcceptanceError(code)),
      duration,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveDeadline(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectDeadline(error);
      },
    );
  });
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, duration, code) {
  if (exited(child)) return Promise.resolve();
  return new Promise((resolveExit, rejectExit) => {
    const finish = () => {
      clearTimeout(timer);
      child.removeListener("exit", finish);
      resolveExit();
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", finish);
      rejectExit(new RuntimeCounterAcceptanceError(code));
    }, duration);
    child.once("exit", finish);
  });
}

function signal(child, value) {
  try {
    child.kill(value);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

export async function closeCounterApplication(application) {
  if (application === null) return;
  const child = application.process();
  try {
    await withDeadline(application.close(), 15_000, "RUNTIME_COUNTER_ELECTRON_CLOSE_TIMEOUT");
  } catch {
    // A bounded process termination below remains authoritative.
  }
  if (exited(child)) return;
  signal(child, "SIGTERM");
  try {
    await waitForExit(child, 2_000, "RUNTIME_COUNTER_ELECTRON_TERM_TIMEOUT");
    return;
  } catch {
    signal(child, "SIGKILL");
  }
  await waitForExit(child, 5_000, "RUNTIME_COUNTER_ELECTRON_KILL_TIMEOUT");
}

export async function launchCounterApplication(launcher, context) {
  if (typeof launcher?.launch !== "function") fail("RUNTIME_COUNTER_ELECTRON_INVALID");
  const arguments_ = [`--user-data-dir=${context.userDataRoot}`, "--use-mock-keychain"];
  assertSecretsNotExposed(
    { file: context.executable, arguments: arguments_, environment: context.environment },
    context.secrets,
  );
  const application = await launcher.launch({
    executablePath: context.executable,
    args: arguments_,
    env: context.environment,
  });
  try {
    return Object.freeze({
      application,
      monitor: monitorElectronOutput(application, context.secrets),
    });
  } catch (error) {
    await closeCounterApplication(application);
    throw error;
  }
}

export async function firstCounterWindow(application) {
  return await withDeadline(
    application.firstWindow(),
    30_000,
    "RUNTIME_COUNTER_ELECTRON_WINDOW_TIMEOUT",
  );
}
