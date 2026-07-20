import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn.js";
import { resolveStatus, type StatusFamily, type StatusShape } from "../lib/status.js";

export type StatusBadgeProps = {
  family: StatusFamily;
  status: string;
  /** Override default label from catalog */
  label?: string;
} & Omit<HTMLAttributes<HTMLSpanElement>, "children">;

function ShapeGlyph({ shape }: { shape: StatusShape }) {
  const common = {
    width: 12,
    height: 12,
    viewBox: "0 0 12 12",
    "aria-hidden": true as const,
    focusable: false as const,
  };
  switch (shape) {
    case "circle":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.5" fill="currentColor" />
        </svg>
      );
    case "ring":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      );
    case "triangle":
      return (
        <svg {...common}>
          <path d="M6 1.5 L11 10.5 H1 Z" fill="currentColor" />
        </svg>
      );
    case "square":
      return (
        <svg {...common}>
          <rect x="2" y="2" width="8" height="8" rx="1" fill="currentColor" />
        </svg>
      );
    case "diamond":
      return (
        <svg {...common}>
          <path d="M6 1 L11 6 L6 11 L1 6 Z" fill="currentColor" />
        </svg>
      );
    default:
      return null;
  }
}

export function StatusBadge({ family, status, label, className, ...rest }: StatusBadgeProps) {
  const desc = resolveStatus(family, status);
  const text = label ?? desc.label;
  return (
    <span
      className={cn("ld-badge", `ld-badge--${desc.tone}`, className)}
      data-family={family}
      data-status={status}
      data-shape={desc.shape}
      {...rest}
    >
      <span className="ld-badge__glyph">
        <ShapeGlyph shape={desc.shape} />
      </span>
      {text}
    </span>
  );
}
