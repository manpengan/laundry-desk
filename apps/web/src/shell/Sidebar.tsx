import { cn } from "@laundry/ui";
import { COUNTER_NAV, type NavItemId } from "../nav.js";

export type SidebarProps = {
  expanded: boolean;
  activeId: NavItemId;
  onSelect: (id: NavItemId) => void;
  onToggleExpand: () => void;
};

export function Sidebar({ expanded, activeId, onSelect, onToggleExpand }: SidebarProps) {
  return (
    <aside
      className={cn("ld-shell-sidebar", expanded && "ld-shell-sidebar--open")}
      aria-label="柜台导航"
    >
      <button
        type="button"
        className="ld-shell-sidebar__toggle"
        onClick={onToggleExpand}
        aria-expanded={expanded}
      >
        {expanded ? "收起" : "展开"}
      </button>
      <nav className="ld-shell-sidebar__nav">
        {COUNTER_NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            className={cn("ld-shell-navitem", activeId === item.id && "ld-shell-navitem--active")}
            onClick={() => onSelect(item.id)}
            title={item.label}
            aria-current={activeId === item.id ? "page" : undefined}
          >
            <span className="ld-shell-navitem__icon" aria-hidden>
              {item.icon}
            </span>
            {expanded ? <span className="ld-shell-navitem__label">{item.label}</span> : null}
          </button>
        ))}
      </nav>
    </aside>
  );
}
