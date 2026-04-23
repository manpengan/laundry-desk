import type { HTMLAttributes } from "react";
import { cn } from "@renderer/lib/utils";

type NoticeVariant = "info" | "success" | "warning" | "error";

const variantClassNames: Record<NoticeVariant, string> = {
  info: "border-blue-100 bg-blue-50/90 text-blue-700",
  success: "border-emerald-100 bg-emerald-50/90 text-emerald-700",
  warning: "border-amber-100 bg-amber-50/90 text-amber-700",
  error: "border-red-100 bg-red-50/90 text-red-700",
};

interface NoticeProps extends HTMLAttributes<HTMLDivElement> {
  variant?: NoticeVariant;
}

export function Notice({ className, variant = "info", ...props }: NoticeProps) {
  return (
    <div
      className={cn(
        "rounded-2xl border px-4 py-3 text-sm font-medium shadow-sm",
        variantClassNames[variant],
        className,
      )}
      {...props}
    />
  );
}
