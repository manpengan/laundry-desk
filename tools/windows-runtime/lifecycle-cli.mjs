import { lifecycle } from "./lifecycle.mjs";
try {
  if (process.argv.length !== 5) throw new Error("WINDOWS_COMPANION_ARGS_INVALID");
  console.log(JSON.stringify(await lifecycle(...process.argv.slice(2))));
} catch (error) {
  console.error(
    /^WINDOWS_COMPANION_[A-Z_]+$/u.test(error.message)
      ? error.message
      : "WINDOWS_COMPANION_LIFECYCLE_FAILED",
  );
  process.exitCode = 1;
}
