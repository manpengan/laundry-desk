import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "./companion-contract.mjs";
import { hashFile, inventory, readBoundedFile, requireRealDirectory } from "./companion-files.mjs";
import {
  absolutePath,
  DELIVERY_SCHEMA,
  deliveryFailure,
  deliveryInstructions,
  parseJson,
  requireDeliveryInput,
} from "./package-delivery-contract.mjs";
import { inspectDeliveryInputs } from "./package-delivery-inspect.mjs";

async function requireNewOutput(output, runtimeDirectory) {
  output = resolve(absolutePath(output));
  await requireRealDirectory(dirname(output));
  const child = relative(resolve(runtimeDirectory), output);
  if (child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child)))
    deliveryFailure("OUTPUT_INSIDE_INPUT");
  try {
    await lstat(output);
    deliveryFailure("OUTPUT_EXISTS");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return output;
}

async function verifiedCopy(source, target, expected) {
  await requireRealDirectory(dirname(source));
  if (JSON.stringify(await hashFile(source)) !== JSON.stringify(expected))
    deliveryFailure("INPUT_CHANGED");
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target, constants.COPYFILE_EXCL);
  if (JSON.stringify(await hashFile(target)) !== JSON.stringify(expected))
    deliveryFailure("COPIED_FILE_CHANGED");
}

async function copyInputs(input, inspected, output) {
  for (const { path, size, sha256 } of inspected.runtime.files)
    await verifiedCopy(join(inspected.runtime.root, path), join(output, "Runtime", path), {
      size,
      sha256,
    });
  for (const counter of inspected.counters) {
    const source = input.counters[counter.profile];
    await verifiedCopy(
      source.installer,
      join(output, "Counter", `counter-${counter.profile}.exe`),
      counter.installer,
    );
    await verifiedCopy(
      source.installed_report,
      join(output, "Evidence", `counter-installed-${counter.profile}.json`),
      counter.receipt,
    );
  }
}

function copiedInput(input, output) {
  return {
    ...input,
    runtime_entry: { ...input.runtime_entry, directory: join(output, "Runtime") },
    counters: Object.fromEntries(
      Object.entries(input.counters).map(([profile, value]) => [
        profile,
        {
          ...value,
          installer: join(output, "Counter", `counter-${profile}.exe`),
          installed_report: join(output, "Evidence", `counter-installed-${profile}.json`),
        },
      ]),
    ),
  };
}

function sortedFiles(files) {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : 1));
}

function approvedFiles(inspected) {
  return sortedFiles([
    ...inspected.runtime.files.map(({ path, size, sha256 }) => ({
      path: `Runtime/${path}`,
      size,
      sha256,
    })),
    ...inspected.counters.flatMap(({ profile, installer, receipt }) => [
      { path: `Counter/counter-${profile}.exe`, ...installer },
      { path: `Evidence/counter-installed-${profile}.json`, ...receipt },
    ]),
  ]);
}

function generatedFile(path, bytes) {
  return { path, size: Buffer.byteLength(bytes), sha256: digest(bytes) };
}

async function requireClosedOutput(output, expected) {
  const actual = await inventory(output);
  const directories = new Set();
  for (const { path } of expected) {
    const parts = path.split("/");
    while (parts.length > 1) {
      parts.pop();
      directories.add(parts.join("/"));
    }
  }
  if (
    JSON.stringify(actual.files) !== JSON.stringify(sortedFiles(expected)) ||
    JSON.stringify([...actual.directories].sort()) !== JSON.stringify([...directories].sort())
  )
    deliveryFailure("OUTPUT_INVENTORY_MISMATCH");
  // File hashing takes time. Recheck directory membership afterwards, from leaves
  // to root, so files added after inventory's initial readdir cannot slip through.
  const approved = [...expected.map(({ path }) => path), ...directories];
  for (const directory of [...directories].sort().reverse().concat("")) {
    const root = join(output, directory);
    await requireRealDirectory(root);
    const prefix = directory ? `${directory}/` : "";
    const names = approved
      .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
      .map((path) => path.slice(prefix.length))
      .sort();
    const entries = await readdir(root, { withFileTypes: true });
    if (
      JSON.stringify(entries.map(({ name }) => name).sort()) !== JSON.stringify(names) ||
      entries.some((entry) =>
        directories.has(`${prefix}${entry.name}`) ? !entry.isDirectory() : !entry.isFile(),
      )
    )
      deliveryFailure("OUTPUT_INVENTORY_MISMATCH");
  }
}

export async function packageWindowsDelivery(raw, requestedOutput) {
  const input = requireDeliveryInput(raw);
  const output = await requireNewOutput(requestedOutput, input.runtime_entry.directory);
  const inspected = await inspectDeliveryInputs(input);
  const approved = approvedFiles(inspected);
  // Claim only a new directory. An existing destination is never replaced or cleaned up.
  await mkdir(output);
  try {
    await copyInputs(input, inspected, output);
    await inspectDeliveryInputs(copiedInput(input, output));
    const instructions = deliveryInstructions(input.source_git_sha);
    await writeFile(join(output, "README.zh-CN.md"), instructions, {
      flag: "wx",
    });
    // Inventory is only a comparison target; it must never grant trust to new files.
    const files = sortedFiles([...approved, generatedFile("README.zh-CN.md", instructions)]);
    await requireClosedOutput(output, files);
    const index = {
      schema: DELIVERY_SCHEMA,
      version: 1,
      assurance: "development_only",
      source_git_sha: input.source_git_sha,
      platform: "win32-x64",
      runtime: {
        manifest_sha256: input.runtime_entry.manifest_sha256,
        entry_sha256: inspected.runtime.evidence.entry_sha256,
        evidence_sha256: input.runtime_entry.evidence_sha256,
        release: inspected.runtime.manifest.runtime_release,
        migration_head: inspected.runtime.manifest.migration_head,
        migrations_sha256: inspected.runtime.manifest.migrations_sha256,
      },
      counters: inspected.counters.map(({ profile, installer, receipt }) => ({
        profile,
        installer: `Counter/counter-${profile}.exe`,
        installer_sha256: installer.sha256,
        installed_report: `Evidence/counter-installed-${profile}.json`,
        installed_report_sha256: receipt.sha256,
      })),
      verification: {
        runtime_inventory: "verified",
        counter_installer: "matched_external_pinned_installation_receipt",
        publisher_signature: "not_verified",
        operational_admission: "pending",
      },
      files,
    };
    const indexBytes = `${JSON.stringify(index, null, 2)}\n`;
    const indexFile = generatedFile("delivery-index.json", indexBytes);
    await writeFile(join(output, "delivery-index.json"), indexBytes, {
      flag: "wx",
    });
    const complete = sortedFiles([...files, indexFile]);
    await requireClosedOutput(output, complete);
    const checksums = complete.map(({ path, sha256 }) => `${sha256}  ${path}\n`).join("");
    const checksumFile = generatedFile("SHA256SUMS", checksums);
    await writeFile(join(output, "SHA256SUMS"), checksums, { flag: "wx" });
    await requireClosedOutput(output, [...complete, checksumFile]);
    return Object.freeze({
      output,
      source_git_sha: input.source_git_sha,
      assurance: "development_only",
      files: complete.length + 1,
      index_sha256: indexFile.sha256,
      checksums_sha256: checksumFile.sha256,
    });
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== "--input" || args[2] !== "--output")
      deliveryFailure("ARGS_INVALID");
    const path = absolutePath(args[1]);
    await requireRealDirectory(dirname(path));
    const metadata = await hashFile(path);
    const input = parseJson(await readBoundedFile(path, metadata, 16_384));
    console.log(JSON.stringify(await packageWindowsDelivery(input, args[3])));
  } catch (error) {
    console.error(
      /^WINDOWS_(?:DELIVERY|COMPANION|RUNTIME_ENTRY)_[A-Z_]+$/u.test(error.message)
        ? error.message
        : "WINDOWS_DELIVERY_FAILED",
    );
    process.exitCode = 1;
  }
}
