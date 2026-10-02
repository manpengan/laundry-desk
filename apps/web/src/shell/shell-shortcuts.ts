import { createContext, useContext, useEffect, useRef } from "react";

import type { ThemePreference } from "../theme.js";

export type ShellShortcut =
  | Readonly<{ kind: "palette" }>
  | Readonly<{ kind: "help" }>
  | Readonly<{ kind: "nav"; digit: string }>;

type ShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing"
>;

/** Pure: map a keydown to a shell-level shortcut (IME composition never triggers). */
export function resolveShellShortcut(event: ShortcutEvent): ShellShortcut | null {
  if (event.isComposing) return null;
  const mod = event.ctrlKey || event.metaKey;
  if (mod && !event.altKey && (event.code === "KeyK" || event.key.toLowerCase() === "k")) {
    return Object.freeze({ kind: "palette" });
  }
  if (mod && !event.altKey && (event.code === "Slash" || event.key === "/")) {
    return Object.freeze({ kind: "help" });
  }
  if (event.altKey && !mod && !event.shiftKey) {
    const match = /^(?:Digit|Numpad)([0-9])$/u.exec(event.code);
    if (match?.[1] !== undefined) return Object.freeze({ kind: "nav", digit: match[1] });
  }
  return null;
}

export type ShellShortcutHandlers = Readonly<{
  onPalette: () => void;
  onHelp: () => void;
  onNavDigit: (digit: string) => void;
}>;

/** Global listener; inert while any modal (shell or page level) is open. */
export function useShellShortcuts(handlers: ShellShortcutHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onKeyDown = (event: KeyboardEvent): void => {
      const shortcut = resolveShellShortcut(event);
      if (shortcut === null) return;
      if (document.querySelector('[aria-modal="true"]') !== null) return;
      event.preventDefault();
      if (shortcut.kind === "palette") handlersRef.current.onPalette();
      else if (shortcut.kind === "help") handlersRef.current.onHelp();
      else handlersRef.current.onNavDigit(shortcut.digit);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}

/** Theme control shared between the shell and Settings → 外观. */
export type ThemeControl = Readonly<{
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}>;

export const ThemeControlContext = createContext<ThemeControl | null>(null);

export function useThemeControl(): ThemeControl | null {
  return useContext(ThemeControlContext);
}
