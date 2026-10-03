import { lifecycle } from "./lifecycle.mjs";
import { INPUT_ACTIONS, readDataOptions } from "./data-options.mjs";
let options;
try {
  const [action, source, digest, ...extra] = process.argv.slice(2);
  const expected =
    action === "restore" ? 2 : ["backup-verify", "backup-drill"].includes(action) ? 1 : 0;
  if (process.argv.length !== 5 + expected) throw new Error("WINDOWS_COMPANION_ARGS_INVALID");
  options = INPUT_ACTIONS.includes(action)
    ? await readDataOptions(action)
    : expected === 2
      ? { backupId: extra[0], confirmation: extra[1] }
      : expected === 1
        ? { backupId: extra[0] }
        : {};
  console.log(JSON.stringify(await lifecycle(action, source, digest, options)));
} catch (error) {
  const code = (value) =>
    typeof value === "string" && /^[A-Z][A-Z0-9_]{1,80}$/u.test(value) ? value : null;
  console.error(
    `WINDOWS_COMPANION_DIAGNOSTIC ${JSON.stringify({
      code: code(error.code),
      cause_code: code(error.cause?.code),
      message_code: code(error.message),
      frames: [...(error.stack ?? "").matchAll(/(lifecycle(?:-[a-z]+)?\.mjs):(\d+):(\d+)/gu)]
        .slice(0, 5)
        .map((match) => `${match[1]}:${match[2]}:${match[3]}`),
    })}`,
  );
  console.error(
    /^WINDOWS_COMPANION_[A-Z_]+$/u.test(error.message)
      ? error.message
      : "WINDOWS_COMPANION_LIFECYCLE_FAILED",
  );
  process.exitCode = 1;
} finally {
  if (Buffer.isBuffer(options?.password)) options.password.fill(0);
}
