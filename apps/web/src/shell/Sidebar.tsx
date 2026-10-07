import { cn, Icon, useMagneticIndicator } from "@laundry/ui";
import { useRef } from "react";
import { COUNTER_NAV, navShortcutKey, type NavItem, type NavItemId } from "../nav.js";

export type SidebarProps = {
  expanded: boolean;
  activeId: NavItemId;
  onSelect: (id: NavItemId) => void;
  onToggleExpand: () => void;
  /** Permission-filtered items; defaults to full COUNTER_NAV (tests / host). */
  items?: readonly NavItem[];
};

export function Sidebar({
  expanded,
  activeId,
  onSelect,
  onToggleExpand,
  items = COUNTER_NAV,
}: SidebarProps) {
  const navRef = useRef<HTMLElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  // 磁性焦点: one glass pill glides to the active page (decorative only).
  const pillReady = useMagneticIndicator(navRef, pillRef, ".ld-shell-navitem--active", activeId);
  return (
    <aside
      className={cn("ld-shell-sidebar", expanded && "ld-shell-sidebar--open")}
      aria-label="柜台导航"
    >
      <div className="ld-shell-brand" aria-hidden="true">
        <span className="ld-shell-brand__mark">
          <Icon name="shirt" size={20} strokeWidth={2} />
        </span>
        {expanded ? <span className="ld-shell-brand__name">洗衣柜台</span> : null}
      </div>
      <nav
        ref={navRef}
        className="ld-shell-sidebar__nav"
        data-pill={pillReady ? "ready" : undefined}
      >
        <span ref={pillRef} className="ld-shell-navpill" aria-hidden="true">
          <span />
        </span>
        {items.map((item, index) => {
          const key = navShortcutKey(index);
          const active = activeId === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={cn("ld-shell-navitem lg-pressable", active && "ld-shell-navitem--active")}
              onClick={() => onSelect(item.id)}
              title={key === null ? item.label : `${item.label}（Alt+${key}）`}
              aria-current={active ? "page" : undefined}
              aria-keyshortcuts={key === null ? undefined : `Alt+${key}`}
              data-nav-id={item.id}
            >
              <span className="ld-shell-navitem__icon" aria-hidden="true">
                <Icon name={item.icon} size={22} />
              </span>
              <span className="ld-shell-navitem__label">
                {expanded ? item.label : item.shortLabel}
              </span>
              {expanded && key !== null ? (
                <span className="ld-shell-navitem__kbd" aria-hidden="true">
                  Alt {key}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>
      <button
        type="button"
        className="ld-shell-sidebar__toggle"
        onClick={onToggleExpand}
        aria-expanded={expanded}
        title={expanded ? "收起侧栏" : "展开侧栏"}
      >
        <Icon name={expanded ? "chevronLeft" : "chevronRight"} size={18} />
        <span>{expanded ? "收起" : "展开"}</span>
      </button>
    </aside>
  );
}
