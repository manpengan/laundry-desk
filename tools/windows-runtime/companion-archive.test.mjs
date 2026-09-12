import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { digest } from "./companion-contract.mjs";

// Minimal stored ZIP fixtures exercise the actual Windows PowerShell 5.1 extractor.
// No fixture executable is ever executed.
function archive(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, attributes = 0, size } of entries) {
    const path = Buffer.from(name);
    const data = Buffer.from("synthetic archive fixture");
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(size ?? data.length, 22);
    header.writeUInt16LE(path.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(size ?? data.length, 24);
    directory.writeUInt16LE(path.length, 28);
    directory.writeUInt32LE(attributes >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    local.push(header, path, data);
    central.push(directory, path);
    offset += header.length + path.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

test(
  "Windows PowerShell extracts selected files and rejects unsafe archives",
  {
    skip: process.platform !== "win32",
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "laundry-archive-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const execute = promisify(execFile);
    const script = fileURLToPath(new URL("./expand-companion-archive.ps1", import.meta.url));
    let sequence = 0;
    async function extract(entries, wrongDigest = false) {
      const id = sequence++;
      const zip = archive(entries);
      const file = join(root, `fixture-${id}.zip`);
      const destination = join(root, `output-${id}`);
      await writeFile(file, zip);
      await execute(
        join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          "-Archive",
          file,
          "-Sha256",
          wrongDigest ? "0".repeat(64) : digest(zip),
          "-Destination",
          destination,
          "-Kind",
          "node",
        ],
        {
          timeout: 30000,
          windowsHide: true,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"),
            ),
            PSModulePath: join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/Modules"),
          },
        },
      );
      return destination;
    }
    const selected = { name: "node-v22.23.2-win-x64/node.exe" };
    const output = await extract([selected, { name: "node-v22.23.2-win-x64/unselected.txt" }]);
    assert.equal(await readFile(join(output, "node.exe"), "utf8"), "synthetic archive fixture");
    await assert.rejects(readFile(join(output, "unselected.txt")), { code: "ENOENT" });
    for (const [entries, code, wrongDigest] of [
      [[selected], "DIGEST_INVALID", true],
      [[selected, { name: "../escape" }], "PATH_INVALID"],
      [[selected, { name: selected.name.toUpperCase() }], "PATH_INVALID"],
      [[{ ...selected, attributes: 0xa0000000 }], "LINK_INVALID"],
      [[{ ...selected, size: 536870913 }], "TOO_LARGE"],
    ]) {
      await assert.rejects(extract(entries, wrongDigest), (error) => {
        assert.match(error.stderr, new RegExp(`WINDOWS_COMPANION_ARCHIVE_${code}`));
        return true;
      });
    }
  },
);
