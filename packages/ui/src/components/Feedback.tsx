import type { ReactNode } from "react";
import { cn } from "../lib/cn.js";
import { Icon, type IconName } from "./Icon.js";

export type BannerTone = "info" | "warn" | "danger" | "ok";

const BANNER_ICON: Readonly<Record<BannerTone, IconName>> = Object.freeze({
  info: "info",
  warn: "alert",
  danger: "alertCircle",
  ok: "check",
});

export type BannerProps = Readonly<{
  tone?: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** "alert" interrupts assistive tech; default "status" is polite. */
  live?: "status" | "alert" | "none";
}>;

/** One alert look for notices, warnings and blockers across every page. */
export function Banner({
  tone = "info",
  title,
  children,
  className,
  live = "status",
}: BannerProps) {
  return (
    <div
      className={cn("ld-banner", tone !== "info" && `ld-banner--${tone}`, className)}
      {...(live === "none" ? {} : { role: live })}
    >
      <span className="ld-banner__icon">
        <Icon name={BANNER_ICON[tone]} size={18} />
      </span>
      <div>
        {title === undefined ? null : <p className="ld-banner__title">{title}</p>}
        {children}
      </div>
    </div>
  );
}

export type KbdProps = Readonly<{ children: ReactNode; className?: string }>;

/** Keyboard shortcut hint, e.g. <Kbd>Ctrl</Kbd>+<Kbd>K</Kbd>. */
export function Kbd({ children, className }: KbdProps) {
  return <kbd className={cn("ld-kbd", className)}>{children}</kbd>;
}
