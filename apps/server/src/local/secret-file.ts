import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const MAXIMUM_SECRET_BYTES = 16_384;

export class SecretFileError extends Error {
  constructor(readonly code: "SECRET_SOURCE_AMBIGUOUS" | "SECRET_FILE_INVALID") {
    super(code);
    this.name = "SecretFileError";
  }
}

type SecretEnvironment = Readonly<Record<string, string | undefined>>;

const readPrivateFile = (path: string): string => {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new SecretFileError("SECRET_FILE_INVALID");
  }

  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAXIMUM_SECRET_BYTES) {
      throw new SecretFileError("SECRET_FILE_INVALID");
    }
    const value = readFileSync(descriptor, "utf8");
    if (
      Buffer.byteLength(value, "utf8") !== metadata.size ||
      value.includes("\0") ||
      value.includes("\n") ||
      value.includes("\r")
    ) {
      throw new SecretFileError("SECRET_FILE_INVALID");
    }
    return value;
  } catch (error) {
    if (error instanceof SecretFileError) throw error;
    throw new SecretFileError("SECRET_FILE_INVALID");
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
};

/** Resolve one secret from either NAME or NAME_FILE, never both. */
export const readSecretValue = (
  environment: SecretEnvironment,
  name: string,
): string | undefined => {
  const direct = environment[name];
  const file = environment[`${name}_FILE`];
  if (direct !== undefined && file !== undefined) {
    throw new SecretFileError("SECRET_SOURCE_AMBIGUOUS");
  }
  if (file !== undefined) return readPrivateFile(file);
  return direct;
};

export const resolveSecretEnvironment = (
  environment: SecretEnvironment,
  names: readonly string[],
): SecretEnvironment =>
  Object.freeze({
    ...environment,
    ...Object.fromEntries(names.map((name) => [name, readSecretValue(environment, name)])),
  });
