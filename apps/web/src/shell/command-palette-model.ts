/** Pure model for the Ctrl+K command palette (UI spec §4.1 顶栏 ⌘K 命令面板). */

import type { IconName } from "@laundry/ui";

export type PaletteGroup = "查找" | "页面" | "操作";

export type PaletteCommand = Readonly<{
  id: string;
  label: string;
  group: PaletteGroup;
  icon: IconName;
  /** Pinyin / initials / English, searched without an IME. */
  keywords?: string;
  hint?: string;
  shortcut?: string;
  /** Lookups always match; this places them between label and keyword hits. */
  fixedScore?: number;
  run: () => void;
}>;

const GROUP_ORDER: readonly PaletteGroup[] = Object.freeze(["查找", "页面", "操作"]);

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, "");
}

/** 0 = no match; higher is better. */
export function commandScore(command: PaletteCommand, query: string): number {
  if (command.fixedScore !== undefined) return command.fixedScore;
  const q = normalize(query);
  if (q.length === 0) return 1;
  const label = normalize(command.label);
  if (label === q) return 5;
  if (label.startsWith(q)) return 4;
  if (label.includes(q)) return 3;
  const words = (command.keywords ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.some((word) => word.startsWith(q))) return 2;
  if (words.some((word) => word.includes(q))) return 1;
  return 0;
}

/** Stable sort: score first, then group order, then declaration order. */
export function filterCommands(
  commands: readonly PaletteCommand[],
  query: string,
): readonly PaletteCommand[] {
  return Object.freeze(
    commands
      .map((command, index) => ({ command, index, score: commandScore(command, query) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        const group =
          GROUP_ORDER.indexOf(left.command.group) - GROUP_ORDER.indexOf(right.command.group);
        if (group !== 0) return group;
        return left.index - right.index;
      })
      .map((entry) => entry.command),
  );
}

/**
 * Free text that looks like a ticket, pickup code, barcode, phone or name is
 * offered as a lookup. Pure command words ("开单") stay plain navigation.
 */
export function lookupQuery(query: string): string | null {
  const trimmed = query.trim();
  if (trimmed.length < 2 || trimmed.length > 64) return null;
  if (/[\r\n\t]/u.test(trimmed)) return null;
  return trimmed;
}

/** Below label hits (3–5) and keyword prefixes (2), above keyword fragments (1). */
const LOOKUP_SCORE = 1.5;

export type LookupHandlers = Readonly<{
  onPickupLookup: (key: string) => void;
  onCustomerSearch: (query: string) => void;
}>;

export function lookupCommands(
  query: string,
  handlers: LookupHandlers,
  canOpen: Readonly<{ pickup: boolean; customers: boolean }>,
): readonly PaletteCommand[] {
  const key = lookupQuery(query);
  if (key === null) return Object.freeze([]);
  const commands: PaletteCommand[] = [];
  if (canOpen.pickup) {
    commands.push(
      Object.freeze({
        id: "lookup:pickup",
        label: `取衣查找“${key}”`,
        hint: "票号 / 取件码 / 条码 / 手机号 / 姓名",
        group: "查找" as const,
        icon: "scan" as const,
        fixedScore: LOOKUP_SCORE,
        run: () => handlers.onPickupLookup(key),
      }),
    );
  }
  if (canOpen.customers) {
    commands.push(
      Object.freeze({
        id: "lookup:customers",
        label: `客户查找“${key}”`,
        hint: "姓名 / 手机号",
        group: "查找" as const,
        icon: "customers" as const,
        fixedScore: LOOKUP_SCORE - 0.1,
        run: () => handlers.onCustomerSearch(key),
      }),
    );
  }
  return Object.freeze(commands);
}

/** Pure: keep the highlighted row inside the result list. */
export function moveActiveIndex(current: number, total: number, delta: 1 | -1): number {
  if (total <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : total - 1;
  return (current + delta + total) % total;
}
