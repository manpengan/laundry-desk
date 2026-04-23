import * as React from "react";
import { cn } from "@renderer/lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-11 w-full rounded-2xl border border-white/70 bg-white/72 px-4 py-2 text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] ring-offset-white backdrop-blur-xl file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-slate-400 focus-visible:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071e3] transition-all disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
