import { createCommandError, type CommandError } from "@laundry/contracts";
import { ZodError } from "zod";

function escapeJsonPointerSegment(value: PropertyKey): string {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Convert boundary parse failures without manufacturing the forbidden root pointer `/`. */
export function validationErrorFrom(error: unknown): CommandError {
  if (!(error instanceof ZodError)) return createCommandError("VALIDATION_FAILED");
  const first = error.issues[0];
  if (first === undefined || first.path.length === 0) {
    return createCommandError("VALIDATION_FAILED");
  }
  const path = `/${first.path.map(escapeJsonPointerSegment).join("/")}`;
  return createCommandError("VALIDATION_FAILED", { kind: "field", path });
}
