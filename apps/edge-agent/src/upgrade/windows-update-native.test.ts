import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runWindowsUpdateRequest } from "./windows-update-process.js";

const SYSTEM_EXE = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const ZIP_FIXTURE = String.raw`
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$q=[Console]::In.ReadToEnd()|ConvertFrom-Json
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[IO.Compression.ZipFile]::Open($q.zip,[IO.Compression.ZipArchiveMode]::Create)
try {
 foreach($file in [IO.Directory]::EnumerateFiles($q.source,'*',[IO.SearchOption]::AllDirectories)) {
  $name=$file.Substring($q.source.Length+1).Replace('\','/')
  $entry=$archive.CreateEntry($name);$source=[IO.File]::OpenRead($file);$out=$entry.Open()
  try{$source.CopyTo($out)}finally{$out.Dispose();$source.Dispose()}
 }
}finally{$archive.Dispose()}
if($q.badName){
 $zip=[IO.Compression.ZipFile]::Open($q.zip,[IO.Compression.ZipArchiveMode]::Update)
 try {$entry=$zip.CreateEntry($q.badName);$writer=[IO.StreamWriter]::new($entry.Open());try{$writer.Write('invalid')}finally{$writer.Dispose()}}finally{$zip.Dispose()}
}
`;
async function createZip(source: string, zip: string, badName?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      SYSTEM_EXE,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(ZIP_FIXTURE, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      },
    );
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.stdout.resume();
    child.stderr.resume();
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("fixture ZIP failed"));
    });
    child.stdin.end(JSON.stringify({ source, zip, badName }));
  });
}

test(
  "Windows native bridge extracts signed system fixture and rejects changed payload and unsafe ZIP entries",
  { skip: process.platform !== "win32", timeout: 180_000 },
  async (t) => {
    // The fixture is a copy of an existing signed OS executable; it is never executed.
    const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-update-native-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, "source");
    await mkdir(join(source, "resources"), { recursive: true });
    await copyFile(SYSTEM_EXE, join(source, "Counter.exe"));
    for (const name of ["app.asar", "a.txt", "b.txt", "c.txt"])
      await writeFile(join(source, "resources", name), "synthetic fixture");
    const zip = join(root, "valid.zip");
    await createZip(source, zip);
    const destination = join(root, "valid");
    await mkdir(destination);
    const request = {
      currentExe: SYSTEM_EXE,
      targetExe: join(destination, "Counter.exe"),
      zipPath: zip,
      destination,
      verifyOnly: false,
    };
    await runWindowsUpdateRequest(request);
    assert.equal(
      (await readFile(join(destination, "resources", "app.asar"))).toString(),
      "synthetic fixture",
    );
    await runWindowsUpdateRequest({ ...request, verifyOnly: true });
    await writeFile(join(destination, "resources", "app.asar"), "tampered fixture!");
    await assert.rejects(
      runWindowsUpdateRequest({ ...request, verifyOnly: true }),
      /UPDATE_WINDOWS_VERIFICATION_FAILED/u,
    );
    for (const [i, badName] of [
      "../escape.txt",
      "resources/a.txt",
      "resources/CON.txt",
      "resources/alternate:stream",
      "resources/back\\slash",
    ].entries()) {
      const archive = join(root, `invalid-${i}.zip`);
      await createZip(source, archive, badName);
      const output = join(root, `invalid-${i}`);
      await mkdir(output);
      await assert.rejects(
        runWindowsUpdateRequest({
          currentExe: SYSTEM_EXE,
          targetExe: join(output, "Counter.exe"),
          zipPath: archive,
          destination: output,
        }),
        /UPDATE_WINDOWS_VERIFICATION_FAILED/u,
      );
    }
  },
);
