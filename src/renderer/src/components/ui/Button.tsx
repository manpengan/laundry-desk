import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@renderer/lib/utils";

const buttonVariants = cva(
  "lg-pressable inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[12px] text-[14px] font-semibold transition-all focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default: "text-[var(--lg-accent-ink)] bg-gradient-to-b from-[var(--lg-accent2)] to-[var(--lg-accent)] shadow-[0_10px_24px_-8px_var(--lg-accent-soft),inset_0_1px_0_rgba(255,255,255,0.35)]",
        destructive: "text-white bg-gradient-to-b from-[#ff6b63] to-[#e0312f] shadow-[0_10px_24px_-8px_rgba(224,49,47,0.4),inset_0_1px_0_rgba(255,255,255,0.3)]",
        outline: "lg-inset text-[var(--lg-ink)] hover:bg-[var(--lg-leaf-hover)]",
        secondary: "bg-[var(--lg-leaf)] text-[var(--lg-ink)] hover:bg-[var(--lg-leaf-hover)]",
        ghost: "text-[var(--lg-ink2)] hover:bg-[var(--lg-leaf)] hover:text-[var(--lg-ink)]",
        link: "text-[var(--lg-accent)] underline-offset-4 hover:underline",
      },
      size: { default: "h-11 px-5", sm: "h-9 px-4 text-[13px]", lg: "h-12 px-7 text-[15px]", icon: "h-10 w-10" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";
export { Button, buttonVariants };
