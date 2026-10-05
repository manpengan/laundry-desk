import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const sourcePath = join(packageRoot, "native", "windows", "LaundryWindowsHelper.cs");
const outputPath = join(packageRoot, "native", "windows", "laundry-windows-helper.exe");

function compilerCandidates(environment) {
  const windowsRoot = environment.WINDIR;
  if (typeof windowsRoot !== "string" || !isAbsolute(windowsRoot)) return Object.freeze([]);
  return Object.freeze([
    join(windowsRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(windowsRoot, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ]);
}

async function regularFile(path) {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

async function findCompiler(environment) {
  for (const candidate of compilerCandidates(environment)) {
    if (await regularFile(candidate)) return candidate;
  }
  throw new Error("WINDOWS_HELPER_CSC_UNAVAILABLE");
}

export async function publishWindowsHelper(temporaryPath, outputPath) {
  const bytes = await readFile(temporaryPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const digestPath = `${outputPath}.sha256`;
  const temporaryDigestPath = `${digestPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryDigestPath, `${digest}\n`, { encoding: "ascii", flag: "wx" });
    await rename(temporaryPath, outputPath);
    // pnpm deploy may hardlink the previous sidecar; never rewrite its shared inode.
    await rename(temporaryDigestPath, digestPath);
    return digest;
  } finally {
    await rm(temporaryDigestPath, { force: true });
  }
}

export async function buildWindowsHelper(environment = process.env, platform = process.platform) {
  if (platform !== "win32") return Object.freeze({ built: false });
  const compiler = await findCompiler(environment);
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp.exe`;
  await rm(temporaryPath, { force: true });
  try {
    await execFileAsync(
      compiler,
      [
        "/nologo",
        "/target:exe",
        "/optimize+",
        "/platform:x64",
        "/r:System.dll",
        "/r:System.Core.dll",
        "/r:System.Drawing.dll",
        `/out:${temporaryPath}`,
        sourcePath,
      ],
      { windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 },
    );
    const digest = await publishWindowsHelper(temporaryPath, outputPath);
    return Object.freeze({ built: true, digest });
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildWindowsHelper().catch(() => {
    process.stderr.write("WINDOWS_HELPER_BUILD_FAILED\n");
    process.exitCode = 1;
  });
}
