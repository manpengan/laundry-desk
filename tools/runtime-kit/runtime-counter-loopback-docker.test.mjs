import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createAcceptanceIdentity,
  resolveLocalDockerEndpoint,
} from "./runtime-counter-loopback-core.mjs";
import { createDockerOperations } from "./runtime-counter-loopback-docker.mjs";

const identity = createAcceptanceIdentity("abc12345def0");
const instanceId = "runtime_instance_owned_123456";
const imageId = `sha256:${"d".repeat(64)}`;
const composeLabels = { "com.docker.compose.project": identity.project };
const volumeLabels = {
  "com.laundry-desk.managed": "true",
  "com.laundry-desk.project": identity.project,
  "com.laundry-desk.instance": instanceId,
};
const result = (stdout, code = 0) => ({ code, stdout, stderr: "" });
const executeFile = promisify(execFile);
const kitRoot = dirname(fileURLToPath(import.meta.url));

async function createEndpoint(t) {
  const root = await mkdtemp(join(tmpdir(), "runtime-counter-docker-test-"));
  const socket = join(root, "docker.sock");
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socket, resolveListen);
  });
  t.after(async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(root, { force: true, recursive: true });
  });
  return resolveLocalDockerEndpoint([socket]);
}

test("validates exact Runtime-owned network, volumes, services and loopback ports", async (t) => {
  const endpoint = await createEndpoint(t);
  const invocations = [];
  const run = async (_docker, rawArguments) => {
    assert.deepEqual(rawArguments.slice(0, 2), ["--host", endpoint.host]);
    invocations.push(rawArguments);
    const arguments_ = rawArguments.slice(2);
    if (arguments_[0] === "volume") return result(JSON.stringify(volumeLabels));
    if (arguments_[0] === "network" && arguments_[1] === "ls") {
      return result("aaaaaaaaaaaa\n");
    }
    if (arguments_[0] === "network" && arguments_[1] === "inspect") {
      return result(JSON.stringify(composeLabels));
    }
    if (arguments_[0] === "container" && arguments_[1] === "ls") {
      const service = arguments_.find((value) => value.includes("compose.service="));
      return result(service?.endsWith("postgres") ? "bbbbbbbbbbbb\n" : "cccccccccccc\n");
    }
    if (arguments_[0] === "container" && arguments_[1] === "inspect") {
      if (arguments_[3].includes("Config.Labels")) {
        return result(JSON.stringify(composeLabels));
      }
      const id = arguments_.at(-1);
      return result(
        JSON.stringify(
          id === "bbbbbbbbbbbb"
            ? { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "8543" }] }
            : { "8787/tcp": [{ HostIp: "127.0.0.1", HostPort: "8787" }] },
        ),
      );
    }
    throw new Error(`unexpected Docker invocation: ${arguments_.join(" ")}`);
  };
  const docker = createDockerOperations({
    docker: "/tmp/docker",
    endpoint,
    environment: {},
    identity,
    run,
  });
  await docker.assertRuntimeOwnership(instanceId);
  assert.ok(invocations.length > 0);
  assert.throws(
    () => docker.execute(["--context", "remote-context", "info"]),
    /RUNTIME_COUNTER_DOCKER_QUERY_INVALID/u,
  );
});

test("cleanup continues to the independently-owned image when volume identity is unknown", async (t) => {
  const endpoint = await createEndpoint(t);
  let imageRemoved = false;
  const run = async (_docker, rawArguments) => {
    assert.deepEqual(rawArguments.slice(0, 2), ["--host", endpoint.host]);
    const arguments_ = rawArguments.slice(2);
    if (["container", "network"].includes(arguments_[0]) && arguments_[1] === "ls") {
      return result("");
    }
    if (arguments_[0] === "volume") {
      return arguments_[3].includes(".Labels")
        ? result(JSON.stringify(volumeLabels))
        : result("", 1);
    }
    if (arguments_[0] === "image" && arguments_[1] === "inspect") {
      if (arguments_[3].includes("Config.Labels")) {
        return result(JSON.stringify({ "com.laundry-desk.acceptance": identity.acceptanceLabel }));
      }
      return imageRemoved ? result("", 1) : result(JSON.stringify(imageId));
    }
    if (arguments_[0] === "image" && arguments_[1] === "rm") {
      imageRemoved = true;
      return result("");
    }
    throw new Error(`unexpected Docker invocation: ${arguments_.join(" ")}`);
  };
  const docker = createDockerOperations({
    docker: "/tmp/docker",
    endpoint,
    environment: {},
    identity,
    run,
  });
  await assert.rejects(
    () => docker.cleanup({ imageId: null, instanceId: null }),
    /RUNTIME_COUNTER_VOLUME_OWNERSHIP_UNKNOWN/u,
  );
  assert.equal(imageRemoved, true);
});

test(
  "SystemRuntimeRunner pins every Docker command to the validated Unix socket",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "runtime-counter-swift-docker-test-"));
    const socket = join(root, "docker.sock");
    const linkedSocket = join(root, "linked.sock");
    const executable = join(root, "runner-test");
    const stub = join(root, "RuntimeStubs.swift");
    const main = join(root, "main.swift");
    const server = createServer();
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(socket, resolveListen);
    });
    await symlink(socket, linkedSocket);
    t.after(async () => {
      await new Promise((resolveClose) => server.close(resolveClose));
      await rm(root, { force: true, recursive: true });
    });
    await writeFile(
      stub,
      `import Foundation\nstruct RuntimeManifestPayload {}\nstruct HarnessFailure: Error { let code: String }\nfunc runtimeFail(_ code: String) throws -> Never { throw HarnessFailure(code: code) }\n`,
    );
    await writeFile(
      main,
      `import Foundation\nextension SystemRuntimeRunner {\n  func runStreaming(_ spec: RuntimeCommandSpec, stream: RuntimeStreamSpec, accepting: Set<Int32>) throws -> RuntimeCommandResult { try runtimeFail("UNUSED") }\n}\nlet socket = CommandLine.arguments[1]\nlet linked = CommandLine.arguments[2]\nsetenv("DOCKER_CONTEXT", "remote-context", 1)\nsetenv("DOCKER_HOST", "ssh://remote.example", 1)\nlet runner = try SystemRuntimeRunner(testDockerPath: "/usr/bin/true", testSocketCandidates: [socket])\nlet spec = RuntimeCommandSpec(executable: runner.dockerPath, arguments: ["image", "inspect", "fixture"], environment: [:])\ntry runner.validate(spec)\nlet process = runner.configuredProcess(spec)\nguard process.arguments == ["--host", "unix://" + socket, "image", "inspect", "fixture"] else { exit(10) }\nguard process.environment?["DOCKER_CONTEXT"] == nil, process.environment?["DOCKER_HOST"] == nil else { exit(11) }\ndo { _ = try SystemRuntimeRunner.resolveLocalDockerHost(candidates: [linked]); exit(12) } catch {}\ndo { _ = try SystemRuntimeRunner.resolveLocalDockerHost(candidates: ["ssh://remote.example"]); exit(13) } catch {}\ndo { try runner.validate(RuntimeCommandSpec(executable: runner.dockerPath, arguments: ["--host", "tcp://remote.example"], environment: [:])); exit(14) } catch {}\n`,
    );
    await executeFile(
      "/usr/bin/xcrun",
      [
        "--sdk",
        "macosx",
        "swiftc",
        "-D",
        "RUNTIME_TESTING",
        stub,
        join(kitRoot, "Sources/ProcessRunner.swift"),
        main,
        "-o",
        executable,
      ],
      { maxBuffer: 2 * 1024 * 1024 },
    );
    await executeFile(executable, [socket, linkedSocket], {
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      maxBuffer: 512 * 1024,
    });
  },
);
