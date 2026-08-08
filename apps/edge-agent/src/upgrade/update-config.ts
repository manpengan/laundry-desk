import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const MAX_UPDATE_CONFIG_BYTES = 16 * 1_024;
const UpdateChannelSchema = z.enum(["beta", "stable", "lts"]);

function isFixedHttpsManifestUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hostname.length > 0 &&
      url.hash === "" &&
      url.search === "" &&
      url.pathname.endsWith(".json") &&
      url.toString() === value
    );
  } catch {
    return false;
  }
}

const EnabledUpdateConfigurationSchema = z
  .object({
    schema_version: z.literal(1),
    enabled: z.literal(true),
    channel: UpdateChannelSchema,
    manifest_url: z.string().max(2_048).refine(isFixedHttpsManifestUrl),
  })
  .strict();

const DisabledUpdateConfigurationSchema = z
  .object({
    schema_version: z.literal(1),
    enabled: z.literal(false),
  })
  .strict();

const UpdateConfigurationSchema = z.discriminatedUnion("enabled", [
  EnabledUpdateConfigurationSchema,
  DisabledUpdateConfigurationSchema,
]);

export type UpdateConfiguration = z.infer<typeof UpdateConfigurationSchema>;
export type EnabledUpdateConfiguration = z.infer<typeof EnabledUpdateConfigurationSchema>;

function freezeConfiguration(configuration: UpdateConfiguration): UpdateConfiguration {
  return Object.freeze({ ...configuration });
}

export function parseUpdateConfiguration(candidate: unknown): UpdateConfiguration {
  return freezeConfiguration(UpdateConfigurationSchema.parse(candidate));
}

async function readBoundedRealFile(path: string): Promise<Buffer> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error("Update configuration path must be canonical");
  }
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > MAX_UPDATE_CONFIG_BYTES
  ) {
    throw new Error("Update configuration must be a bounded real file");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new Error("Update configuration changed while opening");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function loadBundledUpdateConfiguration(path: string): Promise<UpdateConfiguration> {
  const bytes = await readBoundedRealFile(path);
  let candidate: unknown;
  try {
    candidate = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Update configuration must be valid JSON");
  }
  return parseUpdateConfiguration(candidate);
}

export function developmentUpdateConfiguration(env: NodeJS.ProcessEnv): UpdateConfiguration {
  const manifestUrl = env.LAUNDRY_DEV_UPDATE_MANIFEST_URL?.trim();
  const channel = env.LAUNDRY_DEV_UPDATE_CHANNEL?.trim();
  if (manifestUrl === undefined && channel === undefined) {
    return Object.freeze({ schema_version: 1, enabled: false });
  }
  return parseUpdateConfiguration({
    schema_version: 1,
    enabled: true,
    manifest_url: manifestUrl,
    channel,
  });
}

export async function resolveUpdateConfiguration(
  options: Readonly<{
    isPackaged: boolean;
    resourcesPath: string;
    env: NodeJS.ProcessEnv;
  }>,
): Promise<UpdateConfiguration> {
  if (!options.isPackaged) return developmentUpdateConfiguration(options.env);
  return await loadBundledUpdateConfiguration(
    join(options.resourcesPath, "update", "update-config.json"),
  );
}
