import { navShortcutKey, type NavItem, type NavItemId } from "../nav.js";
import { paletteKeywords, paletteLabel, THEME_PALETTES, type ThemePalette } from "../appearance.js";
import type { ThemePreference } from "../theme.js";
import type { PaletteCommand } from "./command-palette-model.js";

export type ShellCommandDeps = Readonly<{
  navItems: readonly NavItem[];
  readOnly: boolean;
  expanded: boolean;
  onNavigate: (id: NavItemId) => void;
  onSwitchStaff: () => void;
  onOpenPrintQueue: () => void;
  onSetTheme: (preference: ThemePreference) => void;
  onSetPalette: (palette: ThemePalette) => void;
  onShowShortcuts: () => void;
  onToggleSidebar: () => void;
}>;

/** Pure: the static command list for the palette (pages + shell actions). */
export function shellCommands(deps: ShellCommandDeps): readonly PaletteCommand[] {
  const pages: PaletteCommand[] = deps.navItems.map((item, index) => {
    const key = navShortcutKey(index);
    return Object.freeze({
      id: `nav:${item.id}`,
      label: item.label,
      group: "页面" as const,
      icon: item.icon,
      keywords: item.keywords,
      ...(key === null ? {} : { shortcut: `Alt+${key}` }),
      run: () => deps.onNavigate(item.id),
    });
  });
  const actions: PaletteCommand[] = [];
  if (!deps.readOnly) {
    actions.push(
      Object.freeze({
        id: "action:switch-staff",
        label: "切换员工",
        group: "操作" as const,
        icon: "switchUser" as const,
        keywords: "qiehuan yuangong qhyg pin switch staff",
        run: deps.onSwitchStaff,
      }),
    );
  }
  actions.push(
    Object.freeze({
      id: "action:print-queue",
      label: "打开打印队列",
      group: "操作" as const,
      icon: "printer" as const,
      keywords: "dayin duilie dy print queue",
      run: deps.onOpenPrintQueue,
    }),
    Object.freeze({
      id: "action:theme-light",
      label: "主题：浅色",
      group: "操作" as const,
      icon: "sun" as const,
      keywords: "zhuti qianse light theme",
      run: () => deps.onSetTheme("light"),
    }),
    Object.freeze({
      id: "action:theme-dark",
      label: "主题：深色",
      group: "操作" as const,
      icon: "moon" as const,
      keywords: "zhuti shense dark theme",
      run: () => deps.onSetTheme("dark"),
    }),
    Object.freeze({
      id: "action:theme-system",
      label: "主题：跟随系统",
      group: "操作" as const,
      icon: "monitor" as const,
      keywords: "zhuti xitong system theme",
      run: () => deps.onSetTheme("system"),
    }),
    ...THEME_PALETTES.map((palette) =>
      Object.freeze({
        id: `action:palette-${palette}`,
        label: `配色：${paletteLabel(palette)}`,
        group: "操作" as const,
        icon: "sparkles" as const,
        keywords: `peise zhuti ps palette ${paletteKeywords(palette)}`,
        run: () => deps.onSetPalette(palette),
      }),
    ),
    Object.freeze({
      id: "action:sidebar",
      label: deps.expanded ? "收起侧栏" : "展开侧栏",
      group: "操作" as const,
      icon: deps.expanded ? ("chevronLeft" as const) : ("chevronRight" as const),
      keywords: "cebian sidebar",
      run: deps.onToggleSidebar,
    }),
    Object.freeze({
      id: "action:shortcuts",
      label: "键盘快捷键",
      group: "操作" as const,
      icon: "keyboard" as const,
      keywords: "kuaijiejian kjj shortcuts help",
      shortcut: "Ctrl+/",
      run: deps.onShowShortcuts,
    }),
  );
  return Object.freeze([...pages, ...actions]);
}
