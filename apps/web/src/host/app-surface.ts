export type AppSurface = "counter" | "owner";

/** Select the one explicit browser-only Owner entry without creating wildcard sub-routes. */
export function appSurfaceFromPathname(pathname: string): AppSurface {
  return pathname === "/owner" || pathname === "/owner/" ? "owner" : "counter";
}
