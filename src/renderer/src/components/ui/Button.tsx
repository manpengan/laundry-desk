import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@renderer/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-full text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071e3] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-[#0071e3] text-white shadow-[0_12px_30px_rgba(0,113,227,0.28)] hover:bg-[#0077ed]",
        destructive:
          "bg-[#ff3b30] text-white shadow-[0_12px_30px_rgba(255,59,48,0.24)] hover:bg-[#ff453a]",
        outline:
          "border border-white/70 bg-white/75 text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] backdrop-blur-xl hover:bg-white",
        secondary: "bg-slate-900/5 text-slate-900 hover:bg-slate-900/10",
        ghost: "text-slate-600 hover:bg-white/70 hover:text-slate-950",
        link: "text-[#0071e3] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-6 py-2",
        sm: "h-9 px-4",
        lg: "h-12 px-8 text-base",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
