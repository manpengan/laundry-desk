import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { cn } from "../lib/cn.js";
import { useFocusTrap } from "../lib/focus-trap.js";
import { Icon } from "./Icon.js";

export type DrawerProps = {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  className?: string;
};

export function Drawer({ open, title, onClose, children, className }: DrawerProps) {
  const drawerRef = useRef<HTMLElement | null>(null);
  useFocusTrap(drawerRef, open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="ld-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        ref={drawerRef}
        className={cn("ld-drawer", "lg-glass", className)}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : "抽屉"}
        tabIndex={-1}
      >
        <header className="ld-drawer__header">
          <div className="ld-drawer__title">{title}</div>
          <button
            type="button"
            className="ld-overlay-close"
            onClick={onClose}
            aria-label="关闭"
            title="关闭（Esc）"
            data-overlay-dismiss=""
          >
            <Icon name="close" size={20} />
          </button>
        </header>
        <div className="ld-drawer__body">{children}</div>
      </aside>
    </>
  );
}
