import * as React from "react";
import { cn } from "@renderer/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        "flex h-11 w-full rounded-[12px] border border-[var(--lg-hair)] bg-[var(--lg-leaf)] px-3.5 text-[14px] text-[var(--lg-ink)] shadow-[inset_0_1px_2px_rgba(15,23,42,0.05)] transition placeholder:text-[var(--lg-ink3)] focus:border-[var(--lg-accent)] focus:outline-none focus:ring-[3px] focus:ring-[var(--lg-accent-soft)]",
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);
Input.displayName = "Input";
export { Input };
