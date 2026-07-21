import type { ReactNode } from "react";
import { cn } from "../lib/cn.js";
import { Button } from "./Button.js";

export type EmptyStateProps = {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: ReactNode;
  className?: string;
};

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
  icon,
  className,
}: EmptyStateProps) {
  return (
    <div className={cn("ld-empty", className)} role="status">
      {icon ? <div className="ld-empty__icon">{icon}</div> : null}
      <h2 className="ld-empty__title">{title}</h2>
      {description ? <p className="ld-empty__desc">{description}</p> : null}
      {actionLabel && onAction ? (
        <Button type="button" variant="primary" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}
