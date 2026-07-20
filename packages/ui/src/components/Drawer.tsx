import type { ReactNode } from "react";
import { useEffect } from "react";
import { Button } from "./Button.js";
import { cn } from "../lib/cn.js";

export type DrawerProps = {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  className?: string;
};

export function Drawer({ open, title, onClose, children, className }: DrawerProps) {
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
        className={cn("ld-drawer", "lg-glass", className)}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : "抽屉"}
      >
        <header className="ld-drawer__header">
          <div>{title}</div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="关闭">
            关闭
          </Button>
        </header>
        <div className="ld-drawer__body">{children}</div>
      </aside>
    </>
  );
}
