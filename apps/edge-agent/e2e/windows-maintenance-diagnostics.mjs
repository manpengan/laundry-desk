const ERROR_KINDS = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError"]);
const EMPTY_EVENTS = Object.freeze({
  closed: false,
  crashed: false,
  page_errors: 0,
  console_errors: 0,
  error_kinds: [],
});

/** @param {unknown} error */
function errorKind(error) {
  return error instanceof Error && ERROR_KINDS.has(error.name) ? error.name : "OtherError";
}

/** @param {string} address */
export function redactedPageUrl(address) {
  try {
    const url = new URL(address);
    if (url.protocol === "app:" && url.host === "local")
      return url.pathname === "/index.html" || url.pathname === "/"
        ? `app://local${url.pathname}`
        : "app://local/<redacted>";
    if (url.href === "about:blank") return "about:blank";
    return ["http:", "https:", "file:", "app:", "chrome-error:"].includes(url.protocol)
      ? `${url.protocol}<redacted>`
      : "<redacted>";
  } catch {
    return "<invalid>";
  }
}

/** @param {import('@playwright/test').Page} page */
export function observeMaintenancePage(page) {
  /** @type {{closed: boolean, crashed: boolean, page_errors: number, console_errors: number, error_kinds: string[]}} */
  let events = { ...EMPTY_EVENTS, error_kinds: /** @type {string[]} */ ([]) };
  const closed = () => {
    events = { ...events, closed: true };
  };
  const crashed = () => {
    events = { ...events, crashed: true };
  };
  /** @param {Error} error */
  const pageError = (error) => {
    events = {
      ...events,
      page_errors: Math.min(events.page_errors + 1, 9999),
      error_kinds: [...new Set([...events.error_kinds, errorKind(error)])],
    };
  };
  /** @param {import('@playwright/test').ConsoleMessage} message */
  const consoleError = (message) => {
    if (message.type() === "error")
      events = { ...events, console_errors: Math.min(events.console_errors + 1, 9999) };
  };
  page.on("close", closed);
  page.on("crash", crashed);
  page.on("pageerror", pageError);
  page.on("console", consoleError);
  return {
    snapshot: () => ({ ...events, error_kinds: [...events.error_kinds] }),
    dispose: () => {
      page.off("close", closed);
      page.off("crash", crashed);
      page.off("pageerror", pageError);
      page.off("console", consoleError);
    },
  };
}

/** @template T @param {() => T} read @param {T} fallback */
function safeRead(read, fallback) {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** @param {unknown} raw */
function safeDom(raw) {
  if (typeof raw !== "object" || raw === null) return { status: "invalid" };
  const value = /** @type {Record<string, unknown>} */ (raw);
  const booleans = [
    "login_present",
    "login_visible",
    "shell_present",
    "shell_visible",
    "backup_region_present",
    "backup_region_visible",
    "backup_alert_present",
    "backup_reading",
    "backup_checked",
    "document_focused",
  ];
  if (booleans.some((key) => typeof value[key] !== "boolean")) return { status: "invalid" };
  return {
    status: "read",
    ...Object.fromEntries(booleans.map((key) => [key, value[key]])),
    document_visibility:
      typeof value.document_visibility === "string" &&
      ["visible", "hidden", "prerender"].includes(value.document_visibility)
        ? value.document_visibility
        : "unknown",
    document_ready:
      typeof value.document_ready === "string" &&
      ["loading", "interactive", "complete"].includes(value.document_ready)
        ? value.document_ready
        : "unknown",
  };
}

/** @param {() => Promise<unknown>} read @param {number} budget */
async function boundedDom(read, budget) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), budget);
  });
  // The rejection handler stays attached after timeout, so a destroyed renderer cannot
  // produce an unhandled late rejection or replace the original acceptance failure.
  const result = Promise.resolve()
    .then(read)
    .then(safeDom, (error) => ({ status: "unavailable", error_kind: errorKind(error) }));
  try {
    return await Promise.race([result, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** @typedef {ReturnType<typeof observeMaintenancePage>} PageObservation */
/** @param {import('@playwright/test').Page} page @param {PageObservation | undefined} observation @param {number} [budgetMs] */
export async function maintenanceDiagnostic(page, observation, budgetMs = 2000) {
  try {
    const budget =
      Number.isSafeInteger(budgetMs) && budgetMs > 0 && budgetMs <= 2000 ? budgetMs : 2000;
    const metadata = {
      url: safeRead(() => redactedPageUrl(page.url()), "<unavailable>"),
      // Browser focus/visibility does not prove whether the native Windows session is locked.
      windows_lock_state: "not_observed",
    };
    const dom = await boundedDom(
      () =>
        page.evaluate(() => {
          /** @param {string} selector */
          const state = (selector) => {
            const element = document.querySelector(selector);
            if (element === null) return { present: false, visible: false };
            const style = getComputedStyle(element),
              rect = element.getBoundingClientRect();
            return {
              present: true,
              visible:
                style.visibility !== "hidden" &&
                style.display !== "none" &&
                rect.width > 0 &&
                rect.height > 0,
            };
          };
          const login = state('[data-page="login"]'),
            shell = state('[data-shell="counter"]');
          const panel = document.querySelector('section[aria-label="备份与恢复"]');
          const region = state('section[aria-label="备份与恢复"]');
          return {
            login_present: login.present,
            login_visible: login.visible,
            shell_present: shell.present,
            shell_visible: shell.visible,
            backup_region_present: region.present,
            backup_region_visible: region.visible,
            backup_alert_present: panel?.querySelector('[role="alert"]') !== null && panel !== null,
            backup_reading: Array.from(panel?.querySelectorAll('[role="status"]') ?? []).some(
              (node) => node.textContent?.trim() === "正在读取本机状态…",
            ),
            backup_checked: Array.from(panel?.querySelectorAll("dt") ?? []).some(
              (node) => node.textContent?.trim() === "状态核对时间",
            ),
            document_focused: document.hasFocus(),
            document_visibility: document.visibilityState,
            document_ready: document.readyState,
          };
        }),
      budget,
    );
    return JSON.stringify({
      ...metadata,
      page_state: safeRead(() => (page.isClosed() ? "closed" : "open"), "unknown"),
      events: observation?.snapshot() ?? EMPTY_EVENTS,
      dom,
    });
  } catch {
    return '{"diagnostic":"unavailable"}';
  }
}

export class MaintenanceDiagnosticError extends Error {}

/** @param {string} code @param {unknown} primary @param {import('@playwright/test').Page} page @param {PageObservation | undefined} observation @param {number} [budgetMs] */
export async function maintenanceFailure(code, primary, page, observation, budgetMs) {
  return new MaintenanceDiagnosticError(
    `${code} ${await maintenanceDiagnostic(page, observation, budgetMs)}`,
    { cause: primary },
  );
}
