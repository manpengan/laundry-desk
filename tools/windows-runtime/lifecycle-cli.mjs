import { lifecycle } from "./lifecycle.mjs";
try {
  if (process.argv.length !== 5) throw new Error("WINDOWS_COMPANION_ARGS_INVALID");
  console.log(JSON.stringify(await lifecycle(...process.argv.slice(2))));
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
}
