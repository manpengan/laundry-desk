import {
  POSTGRES_PORT,
  SERVER_PORT,
  assertDockerId,
  assertExactLoopbackBinding,
  assertOwnedComposeLabels,
  assertOwnedImage,
  assertOwnedVolumeLabels,
  fail,
  localDockerHostArguments,
} from "./runtime-counter-loopback-core.mjs";

function parseJson(value, failureCode) {
  try {
    return JSON.parse(value);
  } catch {
    fail(failureCode);
  }
}

export function createDockerOperations(options) {
  const dockerHostArguments = localDockerHostArguments(options.endpoint);
  const execute = (arguments_, commandOptions = {}) => {
    if (
      !Array.isArray(arguments_) ||
      arguments_.some(
        (argument) =>
          typeof argument !== "string" ||
          argument === "--host" ||
          argument === "-H" ||
          argument === "--context" ||
          argument.startsWith("--host=") ||
          argument.startsWith("--context="),
      )
    ) {
      fail("RUNTIME_COUNTER_DOCKER_QUERY_INVALID");
    }
    return options.run(options.docker, [...dockerHostArguments, ...arguments_], {
      ...commandOptions,
      environment: options.environment,
    });
  };

  const listIds = async (kind, service = undefined) => {
    const arguments_ =
      kind === "container" ? ["container", "ls", "--all", "--quiet"] : ["network", "ls", "--quiet"];
    arguments_.push("--filter", `label=com.docker.compose.project=${options.identity.project}`);
    if (service !== undefined) {
      if (kind !== "container") fail("RUNTIME_COUNTER_DOCKER_QUERY_INVALID");
      arguments_.push("--filter", `label=com.docker.compose.service=${service}`);
    }
    const result = await execute(arguments_, {
      label: `RUNTIME_COUNTER_${kind.toUpperCase()}_LIST`,
    });
    const text = result.stdout.trim();
    if (text === "") return Object.freeze([]);
    return Object.freeze(text.split("\n").map(assertDockerId));
  };

  const inspectLabels = async (kind, id) => {
    const selector = kind === "network" ? ".Labels" : ".Config.Labels";
    const result = await execute(
      [kind, "inspect", "--format", `{{json ${selector}}}`, assertDockerId(id)],
      { label: `RUNTIME_COUNTER_${kind.toUpperCase()}_LABELS` },
    );
    return parseJson(result.stdout, "RUNTIME_COUNTER_DOCKER_LABELS_INVALID");
  };

  const inspectOptional = (kind, name, selector, label) =>
    execute([kind, "inspect", "--format", `{{json ${selector}}}`, name], {
      accepting: [0, 1],
      label,
    });

  const assertVacant = async () => {
    for (const kind of ["container", "network"]) {
      if ((await listIds(kind)).length !== 0) fail("RUNTIME_COUNTER_RESOURCE_PREEXISTS");
    }
    for (const volume of options.identity.volumes) {
      const result = await inspectOptional(
        "volume",
        volume,
        ".Labels",
        "RUNTIME_COUNTER_VOLUME_PREFLIGHT",
      );
      if (result.code === 0) fail("RUNTIME_COUNTER_RESOURCE_PREEXISTS");
    }
    const image = await inspectOptional(
      "image",
      options.identity.imageTag,
      ".Id",
      "RUNTIME_COUNTER_IMAGE_PREFLIGHT",
    );
    if (image.code === 0) fail("RUNTIME_COUNTER_RESOURCE_PREEXISTS");
  };

  const assertRuntimeOwnership = async (instanceId) => {
    for (const volume of options.identity.volumes) {
      const result = await inspectOptional(
        "volume",
        volume,
        ".Labels",
        "RUNTIME_COUNTER_VOLUME_INSPECT",
      );
      if (result.code !== 0) fail("RUNTIME_COUNTER_VOLUME_MISSING");
      assertOwnedVolumeLabels(
        parseJson(result.stdout, "RUNTIME_COUNTER_VOLUME_LABELS_INVALID"),
        options.identity,
        instanceId,
      );
    }
    const networks = await listIds("network");
    if (networks.length !== 1) fail("RUNTIME_COUNTER_NETWORK_INVALID");
    assertOwnedComposeLabels(await inspectLabels("network", networks[0]), options.identity);
    for (const [service, containerPort, hostPort] of [
      ["postgres", 5432, POSTGRES_PORT],
      ["server", 8787, SERVER_PORT],
    ]) {
      const ids = await listIds("container", service);
      if (ids.length !== 1) fail("RUNTIME_COUNTER_SERVICE_CONTAINER_INVALID");
      assertOwnedComposeLabels(await inspectLabels("container", ids[0]), options.identity);
      const ports = await execute(
        ["container", "inspect", "--format", "{{json .NetworkSettings.Ports}}", ids[0]],
        { label: "RUNTIME_COUNTER_PORT_INSPECT" },
      );
      assertExactLoopbackBinding(
        parseJson(ports.stdout, "RUNTIME_COUNTER_PORT_BINDING_INVALID"),
        containerPort,
        hostPort,
      );
    }
  };

  const removeComposeResources = async () => {
    const containers = await listIds("container");
    for (const id of containers) {
      assertOwnedComposeLabels(await inspectLabels("container", id), options.identity);
    }
    if (containers.length > 0) {
      await execute(["container", "rm", "--force", ...containers], {
        accepting: [0, 1],
        label: "RUNTIME_COUNTER_CONTAINER_REMOVE",
      });
    }
    const networks = await listIds("network");
    for (const id of networks) {
      assertOwnedComposeLabels(await inspectLabels("network", id), options.identity);
    }
    if (networks.length > 0) {
      await execute(["network", "rm", ...networks], {
        accepting: [0, 1],
        label: "RUNTIME_COUNTER_NETWORK_REMOVE",
      });
    }
  };

  const removeVolumes = async (instanceId) => {
    const owned = [];
    for (const volume of options.identity.volumes) {
      const inspected = await inspectOptional(
        "volume",
        volume,
        ".Labels",
        "RUNTIME_COUNTER_CLEANUP_VOLUME_INSPECT",
      );
      if (inspected.code !== 0) continue;
      if (typeof instanceId !== "string" || instanceId.length === 0) {
        fail("RUNTIME_COUNTER_VOLUME_OWNERSHIP_UNKNOWN");
      }
      assertOwnedVolumeLabels(
        parseJson(inspected.stdout, "RUNTIME_COUNTER_VOLUME_LABELS_INVALID"),
        options.identity,
        instanceId,
      );
      owned.push(volume);
    }
    for (const volume of owned) {
      await execute(["volume", "rm", "--force", volume], {
        accepting: [0, 1],
        label: "RUNTIME_COUNTER_VOLUME_REMOVE",
      });
    }
  };

  const removeImage = async (expectedImageId) => {
    const labels = await inspectOptional(
      "image",
      options.identity.imageTag,
      ".Config.Labels",
      "RUNTIME_COUNTER_CLEANUP_IMAGE_LABELS",
    );
    if (labels.code !== 0) return;
    assertOwnedImage(
      parseJson(labels.stdout, "RUNTIME_COUNTER_IMAGE_LABELS_INVALID"),
      options.identity,
    );
    const id = await inspectOptional(
      "image",
      options.identity.imageTag,
      ".Id",
      "RUNTIME_COUNTER_CLEANUP_IMAGE_ID",
    );
    if (id.code !== 0) fail("RUNTIME_COUNTER_IMAGE_OWNERSHIP_UNKNOWN");
    const actualImageId = assertDockerId(parseJson(id.stdout, "RUNTIME_COUNTER_IMAGE_ID_INVALID"));
    if (expectedImageId !== null && actualImageId !== expectedImageId) {
      fail("RUNTIME_COUNTER_IMAGE_UNOWNED");
    }
    await execute(["image", "rm", "--force", options.identity.imageTag], {
      accepting: [0, 1],
      label: "RUNTIME_COUNTER_IMAGE_REMOVE",
    });
  };

  const assertClean = async () => {
    for (const kind of ["container", "network"]) {
      if ((await listIds(kind)).length !== 0) {
        fail("RUNTIME_COUNTER_CLEANUP_INCOMPLETE");
      }
    }
    for (const volume of options.identity.volumes) {
      const result = await inspectOptional(
        "volume",
        volume,
        ".Id",
        "RUNTIME_COUNTER_VOLUME_CLEAN_VERIFY",
      );
      if (result.code !== 1) fail("RUNTIME_COUNTER_CLEANUP_INCOMPLETE");
    }
    const image = await inspectOptional(
      "image",
      options.identity.imageTag,
      ".Id",
      "RUNTIME_COUNTER_IMAGE_CLEAN_VERIFY",
    );
    if (image.code !== 1) fail("RUNTIME_COUNTER_CLEANUP_INCOMPLETE");
  };

  const cleanup = async ({ instanceId, imageId }) => {
    let failure = null;
    for (const operation of [
      removeComposeResources,
      () => removeVolumes(instanceId),
      () => removeImage(imageId),
      assertClean,
    ]) {
      try {
        await operation();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== null) throw failure;
  };

  return Object.freeze({
    assertRuntimeOwnership,
    assertVacant,
    cleanup,
    execute,
    listIds,
  });
}
