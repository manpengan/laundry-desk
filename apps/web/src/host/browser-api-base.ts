const LOOPBACK_API_ORIGIN = "http://127.0.0.1:8787";

/** LAN HTTPS is same-origin; local Vite and Electron keep the fixed loopback API. */
export function resolveBrowserApiBaseUrl(
  configured: string | undefined,
  location: Pick<Location, "protocol" | "origin">,
): string {
  if (location.protocol === "https:") return location.origin;
  if (configured !== undefined) return configured;
  return LOOPBACK_API_ORIGIN;
}
