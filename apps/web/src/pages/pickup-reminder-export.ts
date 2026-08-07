import type { ManualListResultView } from "./pickup-reminder-model.js";

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function verifyManualListDigest(value: ManualListResultView): Promise<boolean> {
  if (typeof crypto === "undefined" || crypto.subtle === undefined) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value.csv));
  return hex(digest) === value.content_sha256;
}

export function downloadManualList(value: ManualListResultView): boolean {
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function" ||
    typeof Blob === "undefined"
  ) {
    return false;
  }
  const url = URL.createObjectURL(new Blob([value.csv], { type: "text/csv;charset=utf-8" }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = value.filename;
    anchor.click();
    return true;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function copyManualListPhones(value: ManualListResultView): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== "function") return false;
  try {
    await clipboard.writeText(value.rows.map((row) => row.customer_phone).join("\n"));
    return true;
  } catch {
    return false;
  }
}
