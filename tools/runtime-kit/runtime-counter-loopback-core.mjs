import { lstat } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export const LOOPBACK_HOST = "127.0.0.1";
export const POSTGRES_PORT = 8543;
export const SERVER_PORT = 8787;
export const HEALTH_URL = `http://${LOOPBACK_HOST}:${SERVER_PORT}/health`;
export const SOFTWARE_ONLY_MARKER =
  "RUNTIME_COUNTER_LOOPBACK_ACCEPTANCE_OK assurance=software_only runner=system ports=8543,8787 lifecycle=install,stop,start,restart staged_health=ready window_health=ready cleanup=clean";

const SAFE_RUNTIME_ID = /^[a-z0-9]{8,20}$/u;
const SAFE_DOCKER_ID = /^(?:sha256:)?[0-9a-f]{12,64}$/u;
const PASSTHROUGH_ENVIRONMENT = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PNPM_HOME",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
]);
const FIXED_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const LOCAL_DOCKER_ENDPOINT = Symbol("localDockerEndpoint");

export class RuntimeCounterAcceptanceError extends Error {
  constructor(code) {
    super(code);
    this.name = "RuntimeCounterAcceptanceError";
    this.code = code;
  }
}

export function fail(code) {
  throw new RuntimeCounterAcceptanceError(code);
}

export function createAcceptanceIdentity(runtimeId) {
  if (typeof runtimeId !== "string" || !SAFE_RUNTIME_ID.test(runtimeId)) {
    fail("RUNTIME_COUNTER_ID_INVALID");
  }
  const project = `laundry-desk-runtime-test-${runtimeId}`;
  return Object.freeze({
    runtimeId,
    project,
    imageTag: `laundry-runtime-data-test-${runtimeId}:local`,
    acceptanceLabel: `runtime-counter-${runtimeId}`,
    volumes: Object.freeze([`${project}_pgdata-v2`, `${project}_photos`]),
  });
}

export function selectHostEnvironment(environment, overrides = {}) {
  const selected = Object.fromEntries(
    PASSTHROUGH_ENVIRONMENT.flatMap((name) => {
      const value = environment[name];
      return typeof value === "string" && value.length > 0 ? [[name, value]] : [];
    }),
  );
  const result = { ...selected, PATH: FIXED_PATH, ...overrides };
  for (const [name, value] of Object.entries(result)) {
    if (typeof value !== "string" || value.includes("\0")) {
      fail("RUNTIME_COUNTER_ENVIRONMENT_INVALID");
    }
    if (/password|pin|secret|token|cookie|authorization/iu.test(name)) {
      fail("RUNTIME_COUNTER_SECRET_CHANNEL_INVALID");
    }
  }
  return Object.freeze(result);
}

export function defaultDockerSocketCandidates() {
  let home;
  try {
    home = userInfo().homedir;
  } catch {
    fail("RUNTIME_COUNTER_DOCKER_ENDPOINT_INVALID");
  }
  if (
    typeof home !== "string" ||
    !isAbsolute(home) ||
    resolve(home) !== home ||
    home.includes("\0")
  ) {
    fail("RUNTIME_COUNTER_DOCKER_ENDPOINT_INVALID");
  }
  return Object.freeze([join(home, ".docker/run/docker.sock"), "/var/run/docker.sock"]);
}

export async function resolveLocalDockerEndpoint(candidates = undefined) {
  const selectedCandidates = candidates ?? defaultDockerSocketCandidates();
  if (
    !Array.isArray(selectedCandidates) ||
    selectedCandidates.length === 0 ||
    selectedCandidates.some(
      (candidate) =>
        typeof candidate !== "string" ||
        !isAbsolute(candidate) ||
        resolve(candidate) !== candidate ||
        candidate.includes("\0"),
    )
  ) {
    fail("RUNTIME_COUNTER_DOCKER_ENDPOINT_INVALID");
  }
  for (const candidate of [...new Set(selectedCandidates)]) {
    try {
      const metadata = await lstat(candidate);
      if (metadata.isSocket() && !metadata.isSymbolicLink()) {
        return Object.freeze({
          host: `unix://${candidate}`,
          path: candidate,
          [LOCAL_DOCKER_ENDPOINT]: true,
        });
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        fail("RUNTIME_COUNTER_DOCKER_ENDPOINT_INVALID");
      }
    }
  }
  fail("RUNTIME_COUNTER_DOCKER_ENDPOINT_INVALID");
}

export function localDockerHostArguments(endpoint) {
  if (
    typeof endpoint !== "object" ||
    endpoint === null ||
    Array.isArray(endpoint) ||
    endpoint[LOCAL_DOCKER_ENDPOINT] !== true ||
    typeof endpoint.host !== "string" ||
    !endpoint.host.startsWith("unix://") ||
    endpoint.host !== `unix://${endpoint.path}`
  ) {
    fail("RUNTIME_COUNTER_DOCKER_ENDPOINT_INVALID");
  }
  return Object.freeze(["--host", endpoint.host]);
}

export function createRuntimeArguments(identity, configRoot, imageTag, command) {
  if (
    !isAbsolute(configRoot) ||
    resolve(configRoot) !== configRoot ||
    imageTag !== identity.imageTag ||
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((argument) => typeof argument !== "string" || argument.includes("\0"))
  ) {
    fail("RUNTIME_COUNTER_RUNTIME_ARGS_INVALID");
  }
  return Object.freeze([
    "--test-system-config-root",
    configRoot,
    "--test-runtime-id",
    identity.runtimeId,
    "--test-local-server-image",
    imageTag,
    ...command,
  ]);
}

export function assertSecretsNotExposed(exposure, secrets) {
  const serialized = JSON.stringify(exposure);
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length === 0) {
      fail("RUNTIME_COUNTER_SECRET_INVALID");
    }
    if (serialized.includes(secret)) fail("RUNTIME_COUNTER_SECRET_EXPOSED");
  }
}

export function parseReadyHealth(value) {
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    fail("RUNTIME_COUNTER_HEALTH_INVALID");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Reflect.ownKeys(parsed).length !== 2 ||
    parsed.ok !== true ||
    typeof parsed.data !== "object" ||
    parsed.data === null ||
    Array.isArray(parsed.data) ||
    Reflect.ownKeys(parsed.data).length !== 1 ||
    parsed.data.status !== "ready"
  ) {
    fail("RUNTIME_COUNTER_HEALTH_INVALID");
  }
  return Object.freeze({ ok: true, data: Object.freeze({ status: "ready" }) });
}

export function assertUnavailableHealth(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value.ok !== false ||
    typeof value.error !== "object" ||
    value.error === null ||
    Array.isArray(value.error) ||
    value.error.code !== "RESOURCE_UNAVAILABLE"
  ) {
    fail("RUNTIME_COUNTER_HEALTH_DOWN_INVALID");
  }
}

export function assertExactLoopbackBinding(value, containerPort, hostPort) {
  const key = `${containerPort}/tcp`;
  const bindings = value?.[key];
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 1 ||
    !Array.isArray(bindings) ||
    bindings.length !== 1 ||
    bindings[0]?.HostIp !== LOOPBACK_HOST ||
    bindings[0]?.HostPort !== String(hostPort) ||
    Reflect.ownKeys(bindings[0]).length !== 2
  ) {
    fail("RUNTIME_COUNTER_PORT_BINDING_INVALID");
  }
}

export function assertOwnedVolumeLabels(labels, identity, instanceId) {
  if (
    typeof labels !== "object" ||
    labels === null ||
    Array.isArray(labels) ||
    labels["com.laundry-desk.managed"] !== "true" ||
    labels["com.laundry-desk.project"] !== identity.project ||
    labels["com.laundry-desk.instance"] !== instanceId
  ) {
    fail("RUNTIME_COUNTER_VOLUME_UNOWNED");
  }
}

export function assertOwnedComposeLabels(labels, identity) {
  if (
    typeof labels !== "object" ||
    labels === null ||
    Array.isArray(labels) ||
    labels["com.docker.compose.project"] !== identity.project
  ) {
    fail("RUNTIME_COUNTER_COMPOSE_RESOURCE_UNOWNED");
  }
}

export function assertOwnedImage(labels, identity) {
  if (
    typeof labels !== "object" ||
    labels === null ||
    Array.isArray(labels) ||
    labels["com.laundry-desk.acceptance"] !== identity.acceptanceLabel
  ) {
    fail("RUNTIME_COUNTER_IMAGE_UNOWNED");
  }
}

export function assertDockerId(value) {
  if (typeof value !== "string" || !SAFE_DOCKER_ID.test(value)) {
    fail("RUNTIME_COUNTER_DOCKER_ID_INVALID");
  }
  return value;
}

export function assertOwnedTemporaryRoot(base, candidate) {
  const canonicalBase = resolve(base);
  const canonicalCandidate = resolve(candidate);
  const baseRelative = relative(canonicalBase, canonicalCandidate);
  if (
    !isAbsolute(base) ||
    !isAbsolute(candidate) ||
    baseRelative === "" ||
    baseRelative.startsWith("..") ||
    isAbsolute(baseRelative) ||
    !/^laundry-runtime-counter-[A-Za-z0-9._-]+$/u.test(baseRelative)
  ) {
    fail("RUNTIME_COUNTER_TEMP_ROOT_INVALID");
  }
  return canonicalCandidate;
}

export function stableFailure(error, fallback = "RUNTIME_COUNTER_ACCEPTANCE_FAILED") {
  return error instanceof RuntimeCounterAcceptanceError
    ? error
    : new RuntimeCounterAcceptanceError(fallback);
}
