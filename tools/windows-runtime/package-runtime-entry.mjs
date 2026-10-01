import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "./companion-contract.mjs";
import { hashFile, requireRealDirectory } from "./companion-files.mjs";
import { inspectCompanion } from "./inspect-companion.mjs";
import {
  bootstrapBinding,
  COMMAND_NAME,
  ENTRY_NAME,
  entryFailure,
  OPERATOR_HELPERS,
  powershellBinding,
  renderEntry,
} from "./runtime-entry-contract.mjs";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const command =
  '@echo off\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0runtime-entry.ps1"\r\n';
const utf8Bom = (value) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(value)]);

async function template(name) {
  const path = join(scriptsRoot, name);
  const info = await hashFile(path);
  if (info.size > 65536) entryFailure("TEMPLATE_INVALID");
  return readFile(path, "utf8");
}

export async function packageRuntimeEntry({ payload, manifestSha, sourceSha, output }) {
  if (![payload, output].every((value) => typeof value === "string" && isAbsolute(value)))
    entryFailure("ARGS_INVALID");
  payload = await requireRealDirectory(payload);
  output = resolve(output);
  const within = relative(payload, output);
  if (!within.startsWith("..") && !isAbsolute(within)) entryFailure("OUTPUT_INVALID");
  await requireRealDirectory(dirname(output));
  const manifest = await inspectCompanion(payload, manifestSha);
  const bootstrap = bootstrapBinding(manifest, manifestSha, sourceSha);
  try {
    await lstat(output);
    entryFailure("OUTPUT_EXISTS");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(output);
  try {
    const helpers = [];
    for (const name of OPERATOR_HELPERS) {
      const bytes = utf8Bom(await template(name));
      await writeFile(join(output, name), bytes, { flag: "wx" });
      helpers.push({ path: name, size: bytes.length, sha256: digest(bytes) });
    }
    await writeFile(join(output, COMMAND_NAME), command, { flag: "wx" });
    helpers.push({ path: COMMAND_NAME, size: Buffer.byteLength(command), sha256: digest(command) });
    const entry = utf8Bom(
      renderEntry(await template(ENTRY_NAME), {
        SOURCE_SHA: sourceSha,
        MANIFEST_SHA: manifestSha,
        BOOTSTRAP: powershellBinding(bootstrap),
        OPERATOR_HELPERS: powershellBinding(helpers),
        TRUST: await template("runtime-entry-trust.ps1"),
      }),
    );
    await writeFile(join(output, ENTRY_NAME), entry, { flag: "wx" });
    await cp(payload, join(output, "payload"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await inspectCompanion(payload, manifestSha);
    await inspectCompanion(join(output, "payload"), manifestSha);
    const evidence = Object.freeze({
      schema: "laundry.windows.runtime-operator-entry",
      version: 1,
      assurance: "development_only",
      source_git_sha: sourceSha,
      manifest_sha256: manifestSha,
      entry_sha256: digest(entry),
      bootstrap,
      operator_files: [...helpers, { path: ENTRY_NAME, size: entry.length, sha256: digest(entry) }],
    });
    await writeFile(
      join(output, "release-evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { flag: "wx" },
    );
    return Object.freeze({
      output: await realpath(output),
      source_git_sha: sourceSha,
      manifest_sha256: manifestSha,
      entry_sha256: digest(entry),
      assurance: "development_only",
    });
  } catch (error) {
    await rm(output, { force: true, recursive: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (
      args.length !== 8 ||
      args[0] !== "--payload" ||
      args[2] !== "--manifest-sha" ||
      args[4] !== "--source-sha" ||
      args[6] !== "--output"
    )
      entryFailure("ARGS_INVALID");
    console.log(
      JSON.stringify(
        await packageRuntimeEntry({
          payload: args[1],
          manifestSha: args[3],
          sourceSha: args[5],
          output: args[7],
        }),
      ),
    );
  } catch (error) {
    console.error(
      /^WINDOWS_(?:RUNTIME_ENTRY|COMPANION)_[A-Z_]+$/u.test(error.message)
        ? error.message
        : "WINDOWS_RUNTIME_ENTRY_PACKAGE_FAILED",
    );
    process.exitCode = 1;
  }
}
