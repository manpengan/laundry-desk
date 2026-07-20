import type { ReactNode } from "react";
import { useEffect } from "react";
import { Button } from "./Button.js";
import { cn } from "../lib/cn.js";

export type DialogProps = {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
};

export function Dialog({ open, title, onClose, children, footer, className }: DialogProps) {
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
          className={cn("ld-dialog", "lg-card", className)}
          role="dialog"
          aria-modal="true"
          aria-label={typeof title === "string" ? title : "对话框"}
          onClick={(e) => e.stopPropagation()}
        >
          <header className="ld-dialog__header">
            <div>{title}</div>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="关闭">
              关闭
            </Button>
          </header>
          <div className="ld-dialog__body">{children}</div>
          {footer ? <footer className="ld-dialog__footer">{footer}</footer> : null}
        </div>
      </div>
    </>
  );
}
