import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { cn } from "../lib/cn.js";
import { useFocusTrap } from "../lib/focus-trap.js";
import { Icon } from "./Icon.js";

export type DialogProps = {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
};

export function Dialog({ open, title, onClose, children, footer, className }: DialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(dialogRef, open);

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
      <div className="ld-dialog-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="ld-dialog-wrap">
        <div
          ref={dialogRef}
          className={cn("ld-dialog", "lg-card", className)}
          role="dialog"
          aria-modal="true"
          aria-label={typeof title === "string" ? title : "对话框"}
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
        >
          <header className="ld-dialog__header">
            <div className="ld-dialog__title">{title}</div>
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
          <div className="ld-dialog__body">{children}</div>
          {footer ? <footer className="ld-dialog__footer">{footer}</footer> : null}
        </div>
      </div>
    </>
  );
}
