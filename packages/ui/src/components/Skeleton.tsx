import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn.js";

export type SkeletonProps = {
  /** Visual lines when using block layout */
  lines?: number;
  rounded?: "sm" | "md" | "lg" | "full";
} & Omit<HTMLAttributes<HTMLDivElement>, "style">;

export function Skeleton({ lines = 1, rounded = "md", className, ...rest }: SkeletonProps) {
  if (lines <= 1) {
    return (
      <div
        className={cn("ld-skeleton", `ld-skeleton--${rounded}`, className)}
        aria-hidden
        {...rest}
      />
    );
  }
  return (
    <div className={cn("ld-skeleton-stack", className)} aria-hidden {...rest}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className={cn("ld-skeleton", `ld-skeleton--${rounded}`)} />
      ))}
    </div>
  );
}
