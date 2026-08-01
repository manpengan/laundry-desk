import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const STAGING_ID = /^[0-9a-f]{24}$/u;

export type DurableJsonFileOptions<T> = Readonly<{
  rootPath: string;
  fileName: string;
  maxBytes: number;
  parse: (input: unknown) => T;
  randomStagingId?: () => string;
}>;

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Durable JSON path escaped its private root");
  }
}

async function preparePrivateRoot(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Durable JSON root must be absolute");
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const initial = await lstat(path);
  if (!initial.isDirectory() || initial.isSymbolicLink()) {
    throw new Error("Durable JSON root must be a real directory");
  }
  await chmod(path, PRIVATE_DIRECTORY_MODE);
  const root = await realpath(path);
  const metadata = await lstat(root);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
  ) {
    throw new Error("Durable JSON root must be private");
  }
  return root;
}

function assertPrivateFile(
  metadata: Readonly<{
    dev: number;
    ino: number;
    mode: number;
    nlink: number;
    size: number;
    isFile: () => boolean;
  }>,
  maxBytes: number,
): void {
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o777) !== PRIVATE_FILE_MODE ||
    metadata.size > maxBytes
  ) {
    throw new Error("Invalid private durable JSON file");
  }
}

function sameFile(
  expected: Readonly<{ dev: number; ino: number }>,
  observed: Readonly<{ dev: number; ino: number }>,
): boolean {
  return expected.dev === observed.dev && expected.ino === observed.ino;
}

async function closeQuietly(handle: FileHandle | null): Promise<void> {
  if (handle === null) return;
  try {
    await handle.close();
  } catch {
    // The original durable-write error remains authoritative.
  }
}

export class DurableJsonFile<T> {
  private constructor(
    private readonly root: string,
    private readonly path: string,
    private readonly options: DurableJsonFileOptions<T>,
  ) {}

  static async open<T>(options: DurableJsonFileOptions<T>): Promise<DurableJsonFile<T>> {
    if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(options.fileName)) {
      throw new Error("Invalid durable JSON filename");
    }
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
      throw new Error("Invalid durable JSON size limit");
    }
    const root = await preparePrivateRoot(options.rootPath);
    const path = join(root, options.fileName);
    assertContained(root, path);
    return new DurableJsonFile(root, path, options);
  }

  async read(): Promise<T | null> {
    let expected;
    try {
      expected = await lstat(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (expected.isSymbolicLink()) throw new Error("Durable JSON file cannot be a symlink");
    assertPrivateFile(expected, this.options.maxBytes);
    const handle = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      assertPrivateFile(opened, this.options.maxBytes);
      if (!sameFile(expected, opened)) throw new Error("Durable JSON file changed before open");
      const bytes = await handle.readFile();
      const final = await handle.stat();
      assertPrivateFile(final, this.options.maxBytes);
      if (
        !sameFile(opened, final) ||
        final.size !== opened.size ||
        final.mtimeMs !== opened.mtimeMs ||
        bytes.byteLength !== final.size
      ) {
        throw new Error("Durable JSON file changed while reading");
      }
      return this.options.parse(JSON.parse(bytes.toString("utf8")) as unknown);
    } finally {
      await handle.close();
    }
  }

  async write(value: T): Promise<void> {
    const serialized = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > this.options.maxBytes) {
      throw new Error("Durable JSON value is too large");
    }
    const randomId = this.options.randomStagingId?.() ?? randomBytes(12).toString("hex");
    if (!STAGING_ID.test(randomId)) throw new Error("Invalid durable JSON staging id");
    const staging = join(this.root, `.${this.options.fileName}.${randomId}.staging`);
    assertContained(this.root, staging);
    let handle: FileHandle | null = null;
    let created = false;
    let renamed = false;
    try {
      handle = await open(
        staging,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        PRIVATE_FILE_MODE,
      );
      created = true;
      await handle.chmod(PRIVATE_FILE_MODE);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(staging, this.path);
      renamed = true;
      await this.syncRoot();
    } catch (error) {
      await closeQuietly(handle);
      if (created && !renamed) {
        await unlink(staging).catch(() => undefined);
        await this.syncRoot().catch(() => undefined);
      }
      throw error;
    }
  }

  private async syncRoot(): Promise<void> {
    const directory = await open(this.root, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
