import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const fixture = "Laundry_QA_中文_é_😀";
const sourcePath = fileURLToPath(
  new URL("../native/windows/LaundryWindowsHelper.cs", import.meta.url),
);
const harnessSource = String.raw`
using System;
using System.IO;
using System.Reflection;
using System.Text;

internal static class Utf8Harness
{
    private static int Main(string[] arguments)
    {
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), Encoding.GetEncoding(1252))
        {
            AutoFlush = true
        });
        Type helper = Assembly.LoadFile(Path.GetFullPath(arguments[0]))
            .GetType("Laundry.WindowsHelper.Program", true);
        MethodInfo main = helper.GetMethod("Main", BindingFlags.Static | BindingFlags.NonPublic);
        object exit = main.Invoke(null, new object[] { new string[0] });
        if (!(exit is int) || (int)exit != 1) return 3;
        MethodInfo jsonString = helper.GetMethod("JsonString", BindingFlags.Static | BindingFlags.NonPublic);
        string value = "Laundry_QA_\u4e2d\u6587_\u00e9_\ud83d\ude00";
        string quoted = (string)jsonString.Invoke(null, new object[] { value });
        Console.Out.WriteLine("{\"fixture\":" + quoted + "}");
        return 0;
    }
}
`;

async function findCompiler(): Promise<string> {
  const windowsRoot = process.env.WINDIR;
  assert.ok(windowsRoot !== undefined && isAbsolute(windowsRoot));
  for (const framework of ["Framework64", "Framework"]) {
    const candidate = join(windowsRoot, "Microsoft.NET", framework, "v4.0.30319", "csc.exe");
    const metadata = await lstat(candidate).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (metadata?.isFile() && !metadata.isSymbolicLink()) return candidate;
  }
  throw new Error("WINDOWS_HELPER_CSC_UNAVAILABLE");
}

async function compile(compiler: string, source: string, output: string): Promise<void> {
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
      `/out:${output}`,
      source,
    ],
    { windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 },
  );
}

test(
  "the actual Windows helper writes UTF-8 after a legacy-encoded caller, without closing its writer",
  { skip: process.platform !== "win32" },
  async () => {
    const compiler = await findCompiler();
    const root = await mkdtemp(join(tmpdir(), "laundry-helper-utf8-"));
    try {
      const helperSource = join(root, "LaundryWindowsHelper.cs");
      const harnessPath = join(root, "Utf8Harness.cs");
      const helper = join(root, "helper.exe");
      const harness = join(root, "utf8-harness.exe");
      await writeFile(helperSource, await readFile(sourcePath), { flag: "wx" });
      assert.equal(/[^\x00-\x7f]/u.test(harnessSource), false);
      await writeFile(harnessPath, harnessSource, { encoding: "ascii", flag: "wx" });
      await compile(compiler, helperSource, helper);
      await compile(compiler, harnessPath, harness);

      const { stdout, stderr } = await execFileAsync(harness, [helper], {
        encoding: "buffer",
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 16 * 1024,
      });
      assert.equal(
        stderr.toString("ascii"),
        "WINDOWS_HELPER_FAILED:InvalidOperationException:80131509\r\n",
      );
      assert.notDeepEqual(stdout.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
      const text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
      const value: unknown = JSON.parse(text);
      assert.deepEqual(value, { fixture });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
