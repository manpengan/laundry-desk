import assert from "node:assert/strict";
import test from "node:test";

import { COUNTER_NAV, navShortcutKey, navTargetForDigit } from "../nav.js";
import {
  COUNTER_DEFAULT_THEME,
  initialCounterTheme,
  parseThemePreference,
  readStoredThemePreference,
  THEME_STORAGE_KEY,
  writeStoredThemePreference,
} from "../theme.js";
import {
  commandScore,
  filterCommands,
  lookupCommands,
  lookupQuery,
  moveActiveIndex,
  type PaletteCommand,
} from "./command-palette-model.js";
import { shellCommands } from "./shell-commands.js";
import { resolveShellShortcut } from "./shell-shortcuts.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
}

const noop = (): void => undefined;

function command(
  id: string,
  label: string,
  keywords = "",
  group: PaletteCommand["group"] = "页面",
) {
  return Object.freeze({ id, label, keywords, group, icon: "home" as const, run: noop });
}

test("every rail item has an icon, short label and IME-free keywords", () => {
  for (const item of COUNTER_NAV) {
    assert.ok(item.shortLabel.length > 0 && item.shortLabel.length <= 3, item.id);
    assert.ok(item.keywords.split(" ").length >= 2, item.id);
  }
});

test("Alt+digit maps 1…9, 0 to the visible rail order", () => {
  assert.equal(navShortcutKey(0), "1");
  assert.equal(navShortcutKey(8), "9");
  assert.equal(navShortcutKey(9), "0");
  assert.equal(navShortcutKey(10), null);
  assert.equal(navTargetForDigit(COUNTER_NAV, "1"), "workbench");
  assert.equal(navTargetForDigit(COUNTER_NAV, "0"), "settings");
  const clerkRail = COUNTER_NAV.filter((item) => item.id !== "delivery");
  assert.equal(navTargetForDigit(clerkRail, "4"), "fulfillment");
  assert.equal(navTargetForDigit(clerkRail, "0"), null);
  assert.equal(navTargetForDigit(COUNTER_NAV, "x"), null);
});

test("shell shortcuts ignore IME composition and plain typing", () => {
  const base = {
    key: "",
    code: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
  };
  assert.deepEqual(resolveShellShortcut({ ...base, key: "k", code: "KeyK", ctrlKey: true }), {
    kind: "palette",
  });
  assert.deepEqual(resolveShellShortcut({ ...base, key: "K", code: "KeyK", metaKey: true }), {
    kind: "palette",
  });
  assert.deepEqual(resolveShellShortcut({ ...base, key: "/", code: "Slash", ctrlKey: true }), {
    kind: "help",
  });
  assert.deepEqual(resolveShellShortcut({ ...base, key: "2", code: "Digit2", altKey: true }), {
    kind: "nav",
    digit: "2",
  });
  assert.deepEqual(resolveShellShortcut({ ...base, key: "3", code: "Numpad3", altKey: true }), {
    kind: "nav",
    digit: "3",
  });
  assert.equal(resolveShellShortcut({ ...base, key: "k", code: "KeyK" }), null);
  assert.equal(
    resolveShellShortcut({ ...base, key: "k", code: "KeyK", ctrlKey: true, isComposing: true }),
    null,
  );
  assert.equal(
    resolveShellShortcut({ ...base, key: "2", code: "Digit2", altKey: true, shiftKey: true }),
    null,
  );
});

test("palette ranks label hits over keyword hits and lookups in between", () => {
  const pages = [
    command("nav:receive", "开单", "kaidan kd"),
    command("nav:pickup", "取衣", "quyi qy"),
  ];
  assert.equal(commandScore(pages[0]!, "开单"), 5);
  assert.equal(commandScore(pages[1]!, "qy"), 2);
  assert.equal(commandScore(pages[1]!, "uyi"), 1);
  assert.equal(commandScore(pages[0]!, "zzz"), 0);
  const lookups = lookupCommands(
    "开单",
    { onPickupLookup: noop, onCustomerSearch: noop },
    { pickup: true, customers: true },
  );
  const ranked = filterCommands([...lookups, ...pages], "开单");
  assert.equal(ranked[0]?.id, "nav:receive", "exact page beats a lookup with the same words");
  const phone = filterCommands(
    [
      ...lookupCommands(
        "13996764629",
        { onPickupLookup: noop, onCustomerSearch: noop },
        { pickup: true, customers: true },
      ),
      ...pages,
    ],
    "13996764629",
  );
  assert.deepEqual(
    phone.map((entry) => entry.id),
    ["lookup:pickup", "lookup:customers"],
  );
});

test("lookups respect permissions and bounds", () => {
  const handlers = { onPickupLookup: noop, onCustomerSearch: noop };
  assert.equal(lookupQuery(" a "), null);
  assert.equal(lookupQuery("x".repeat(65)), null);
  assert.equal(lookupQuery(" 20261002-0001 "), "20261002-0001");
  assert.deepEqual(
    lookupCommands("13800000000", handlers, { pickup: false, customers: true }).map(
      (entry) => entry.id,
    ),
    ["lookup:customers"],
  );
  assert.equal(moveActiveIndex(2, 3, 1), 0);
  assert.equal(moveActiveIndex(0, 3, -1), 2);
  assert.equal(moveActiveIndex(-1, 0, 1), -1);
});

test("shell commands hide staff switching in read-only mode and list every page", () => {
  const deps = {
    navItems: COUNTER_NAV,
    expanded: false,
    onNavigate: noop,
    onSwitchStaff: noop,
    onOpenPrintQueue: noop,
    onSetTheme: noop,
    onShowShortcuts: noop,
    onToggleSidebar: noop,
  };
  const live = shellCommands({ ...deps, readOnly: false });
  const readOnly = shellCommands({ ...deps, readOnly: true });
  assert.equal(live.filter((entry) => entry.group === "页面").length, COUNTER_NAV.length);
  assert.ok(live.some((entry) => entry.id === "action:switch-staff"));
  assert.ok(!readOnly.some((entry) => entry.id === "action:switch-staff"));
  assert.equal(live.find((entry) => entry.id === "nav:settings")?.shortcut, "Alt+0");
});

test("counter theme defaults to light and survives a blocked store", () => {
  assert.equal(COUNTER_DEFAULT_THEME, "light");
  assert.equal(initialCounterTheme(null), "light");
  assert.equal(parseThemePreference("dark"), "dark");
  assert.equal(parseThemePreference("sepia"), null);
  const storage = memoryStorage();
  writeStoredThemePreference(storage, "system");
  assert.equal(storage.values.get(THEME_STORAGE_KEY), "system");
  assert.equal(readStoredThemePreference(storage), "system");
  assert.equal(initialCounterTheme(storage), "system");
  const throwing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(readStoredThemePreference(throwing), null);
  assert.doesNotThrow(() => writeStoredThemePreference(throwing, "dark"));
});

test("top bar offers Ctrl+K search and no longer hosts the theme toggle", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { TopBar } = await import("./TopBar.js");
  const { createMockConnection } = await import("../connection.js");
  const html = renderToStaticMarkup(
    createElement(TopBar, {
      connection: createMockConnection(),
      onOpenCommand: noop,
      onSwitchStaff: noop,
      onOpenPrintQueue: noop,
    }),
  );
  assert.match(html, /class="ld-shell-command"[^>]*aria-keyshortcuts="Control\+K"/u);
  assert.match(html, />切换员工</u);
  assert.match(html, /全部已同步/u);
  assert.doesNotMatch(html, /主题：/u);
  assert.doesNotMatch(html, /\sstyle=/u);
});

test("collapsed rail still names every page and advertises Alt shortcuts", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { Sidebar } = await import("./Sidebar.js");
  const html = renderToStaticMarkup(
    createElement(Sidebar, {
      expanded: false,
      activeId: "receive",
      onSelect: noop,
      onToggleExpand: noop,
    }),
  );
  for (const item of COUNTER_NAV) {
    assert.match(html, new RegExp(`data-nav-id="${item.id}"`, "u"));
    assert.match(html, new RegExp(`>${item.shortLabel}<`, "u"));
  }
  assert.match(
    html,
    /aria-current="page"[^>]*aria-keyshortcuts="Alt\+2"[^>]*data-nav-id="receive"/u,
  );
  assert.match(html, /aria-expanded="false"/u);
  assert.doesNotMatch(html, /\sstyle=/u);
});
