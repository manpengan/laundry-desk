export type AppSurface = "counter" | "owner" | "mobile_delivery_tasks";

/** Select explicit browser-only surfaces without creating wildcard sub-routes. */
export function appSurfaceFromPathname(pathname: string): AppSurface {
  if (pathname === "/owner" || pathname === "/owner/") return "owner";
  if (pathname === "/mobile/tasks" || pathname === "/mobile/tasks/") {
    return "mobile_delivery_tasks";
  }
  return "counter";
}

/** Browser refresh-cookie resume is opt-in only for the exact mobile task surface. */
export function shouldResumeHostSession(
  hostKind: "browser" | "desktop",
  surface: AppSurface,
): boolean {
  return hostKind === "desktop" || surface === "mobile_delivery_tasks";
}
