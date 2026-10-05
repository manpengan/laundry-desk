const SIDEBAR_STORAGE_KEY = "ld.counter.sidebar";

export function readSidebarExpanded(): boolean {
  try {
    return (
      typeof window !== "undefined" && window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1"
    );
  } catch {
    return false;
  }
}

export function writeSidebarExpanded(expanded: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, expanded ? "1" : "0");
  } catch {
    // Sidebar preference storage is optional and contains no customer information.
  }
}
