export type AppSurface = "counter" | "owner" | "customer";

/** Select the one explicit browser-only Owner entry without creating wildcard sub-routes. */
export function appSurfaceFromPathname(pathname: string): AppSurface {
  if (pathname === "/customer" || pathname === "/customer/") return "customer";
  return pathname === "/owner" || pathname === "/owner/" ? "owner" : "counter";
}
