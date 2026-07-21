import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn.js";

export type SkeletonProps = {
  /** Visual lines when using block layout */
  lines?: number;
  width?: string | number;
  height?: string | number;
  rounded?: "sm" | "md" | "lg" | "full";
} & HTMLAttributes<HTMLDivElement>;

export function Skeleton({
  lines = 1,
  width,
  height,
  rounded = "md",
  className,
  style,
  ...rest
}: SkeletonProps) {
  if (lines <= 1) {
    return (
      <div
        className={cn("ld-skeleton", `ld-skeleton--${rounded}`, className)}
        style={{ width, height, ...style }}
        aria-hidden
        {...rest}
      />
    );
  }
  return (
    <div className={cn("ld-skeleton-stack", className)} aria-hidden {...rest}>
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className={cn("ld-skeleton", `ld-skeleton--${rounded}`)}
          style={{
            width: i === lines - 1 ? "72%" : (width ?? "100%"),
            height: height ?? 12,
          }}
        />
      ))}
    </div>
  );
}
