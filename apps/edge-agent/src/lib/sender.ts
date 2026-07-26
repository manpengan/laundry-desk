/** IPC sender must come from the exact normalized app://local built-in SPA authority. */

export function isValidAppSender(senderUrl: string | undefined | null): boolean {
  if (typeof senderUrl !== "string" || senderUrl.length === 0) return false;
  let url: URL;
  try {
    url = new URL(senderUrl);
  } catch {
    return false;
  }

  return (
    url.href === senderUrl &&
    url.protocol === "app:" &&
    url.hostname === "local" &&
    url.host === "local" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.pathname.startsWith("/") &&
    !url.pathname.startsWith("//") &&
    !url.pathname.includes("%") &&
    !url.pathname.includes("\\") &&
    url.pathname.split("/").every((segment) => segment !== "." && segment !== "..")
  );
}

export type DesktopSenderEvidence = Readonly<{
  senderUrl: string | undefined | null;
  senderWebContentsId: number;
  expectedWebContentsId: number;
  isMainFrame: boolean;
}>;

/** Bind every desktop capability invocation to one expected BrowserWindow main frame. */
export function isValidDesktopSender(evidence: DesktopSenderEvidence): boolean {
  return (
    evidence.isMainFrame &&
    evidence.senderWebContentsId === evidence.expectedWebContentsId &&
    isValidAppSender(evidence.senderUrl)
  );
}
