import type { AccountingExportView } from "./accounting-report-model.js";

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyAccountingExport(value: AccountingExportView): Promise<boolean> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return false;
  try {
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value.csv));
    return hex(digest) === value.content_sha256;
  } catch {
    return false;
  }
}

export async function downloadAccountingExport(value: AccountingExportView): Promise<boolean> {
  if (!(await verifyAccountingExport(value))) return false;
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
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    return true;
  } finally {
    URL.revokeObjectURL(url);
  }
}
