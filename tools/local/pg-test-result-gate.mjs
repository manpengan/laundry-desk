import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const WINDOWS_ONLY =
  "Windows native DPAPI survives KMS instance restart and rejects another identity";

/** Database tests may not skip; the one native Windows case runs on Windows instead. */
export function assertPgTestResult(log, platform = process.platform) {
  const lines = log.split(/\r?\n/u);
  const summary = (name) => {
    const matches = lines.filter((line) => new RegExp(`^# ${name} [0-9]+$`, "u").test(line));
    if (matches.length !== 1) throw new Error("PG_TEST_SUMMARY_INVALID");
    return Number(matches[0].split(" ")[2]);
  };
  const skipped = summary("skipped");
  if (summary("tests") <= skipped || summary("fail") !== 0 || summary("cancelled") !== 0)
    throw new Error("PG_TEST_RESULT_FAILED");
  const skipNames = lines.flatMap((line) => {
    const match = /^\s*ok [0-9]+ - (.+?) # SKIP(?: .*)?$/u.exec(line);
    return match === null ? [] : [match[1]];
  });
  if (
    skipped !== skipNames.length ||
    skipNames.length > 1 ||
    skipNames.some((name) => platform === "win32" || name !== WINDOWS_ONLY)
  )
    throw new Error("PG_DATABASE_TEST_SKIPPED");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error("PG_TEST_LOG_REQUIRED");
    assertPgTestResult(await readFile(process.argv[2], "utf8"));
    process.stdout.write("PG_DATABASE_TESTS_VERIFIED\n");
  } catch {
    process.stderr.write("PG_DATABASE_TEST_RESULT_REJECTED\n");
    process.exitCode = 1;
  }
}
