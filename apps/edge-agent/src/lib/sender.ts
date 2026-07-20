/** IPC sender must come from the app:// built-in SPA (not a remote page). */

export function isValidAppSender(senderUrl: string | undefined | null): boolean {
  if (typeof senderUrl !== "string" || senderUrl.length === 0) return false;
  return senderUrl.startsWith("app://");
}
