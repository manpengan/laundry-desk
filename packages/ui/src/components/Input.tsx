import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn.js";

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  error?: string;
  hint?: ReactNode;
};

export function Input({ label, error, hint, className, id, ...rest }: InputProps) {
  const inputId = id ?? rest.name;
  return (
    <label className="ld-field" style={{ display: "block" }}>
      {label ? (
        <span
          style={{
            display: "block",
            marginBottom: 6,
            fontSize: 13,
            fontWeight: 600,
            color: "var(--lg-ink2)",
          }}
        >
          {label}
        </span>
      ) : null}
      <input
        id={inputId}
        className={cn("ld-input", error && "ld-input--error", className)}
        aria-invalid={error ? true : undefined}
        {...rest}
      />
      {error ? <div className="ld-field-error">{error}</div> : null}
      {!error && hint ? (
        <div style={{ marginTop: 4, fontSize: 12, color: "var(--lg-ink3)" }}>{hint}</div>
      ) : null}
    </label>
  );
}
