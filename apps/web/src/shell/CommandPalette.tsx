import { Icon, Kbd, useFocusTrap } from "@laundry/ui";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { filterCommands, moveActiveIndex, type PaletteCommand } from "./command-palette-model.js";

export type CommandPaletteProps = Readonly<{
  open: boolean;
  onClose: () => void;
  commands: readonly PaletteCommand[];
  /** Dynamic lookups ("取衣查找…") computed from the typed text. */
  lookups: (query: string) => readonly PaletteCommand[];
}>;

const LIST_ID = "ld-command-palette-list";

export function CommandPalette({ open, onClose, commands, lookups }: CommandPaletteProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  useFocusTrap(panelRef, open);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const results = useMemo(
    () => filterCommands([...lookups(query), ...commands], query),
    [commands, lookups, query],
  );
  const activeIndex = results.length === 0 ? -1 : Math.min(active, results.length - 1);

  if (!open) return null;

  const run = (command: PaletteCommand | undefined): void => {
    if (command === undefined) return;
    onClose();
    command.run();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive(moveActiveIndex(activeIndex, results.length, event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(results[activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <>
      <div className="ld-dialog-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="ld-command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        tabIndex={-1}
      >
        <div className="ld-command-palette__search">
          <Icon name="search" size={20} />
          <input
            className="ld-command-palette__input"
            data-autofocus=""
            role="combobox"
            aria-expanded="true"
            aria-controls={LIST_ID}
            aria-autocomplete="list"
            aria-activedescendant={
              activeIndex >= 0 ? `ld-cmd-${results[activeIndex]?.id}` : undefined
            }
            aria-label="搜索功能、票号、手机号或客户"
            placeholder="搜索功能，或输入票号 / 手机号 / 客户姓名…"
            value={query}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <Kbd>Esc</Kbd>
        </div>
        <ul className="ld-command-palette__list" id={LIST_ID} role="listbox" aria-label="命令">
          {results.length === 0 ? (
            <li className="ld-command-palette__empty" role="presentation">
              没有匹配的功能；输入至少 2 个字符可查找订单或客户
            </li>
          ) : (
            results.map((command, index) => (
              <li
                key={command.id}
                id={`ld-cmd-${command.id}`}
                role="option"
                aria-selected={index === activeIndex}
                className="ld-command-palette__item"
                onMouseEnter={() => setActive(index)}
                onClick={() => run(command)}
              >
                <span className="ld-command-palette__icon">
                  <Icon name={command.icon} size={18} />
                </span>
                <span className="ld-command-palette__text">
                  <span className="ld-command-palette__label">{command.label}</span>
                  {command.hint === undefined ? null : (
                    <span className="ld-command-palette__hint">{command.hint}</span>
                  )}
                </span>
                <span className="ld-command-palette__meta">
                  {command.shortcut === undefined ? command.group : <Kbd>{command.shortcut}</Kbd>}
                </span>
              </li>
            ))
          )}
        </ul>
        <footer className="ld-command-palette__footer">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> 选择
          </span>
          <span>
            <Kbd>Enter</Kbd> 执行
          </span>
          <span>
            <Kbd>Ctrl</Kbd> + <Kbd>/</Kbd> 全部快捷键
          </span>
        </footer>
      </div>
    </>
  );
}
