import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn.js";

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "style"> & {
  label?: string;
  error?: string;
  hint?: ReactNode;
};

export function Input({ label, error, hint, className, id, ...rest }: InputProps) {
  const inputId = id ?? rest.name;
  return (
    <label className="ld-field">
      {label ? <span className="ld-field__label">{label}</span> : null}
      <input
        id={inputId}
        className={cn("ld-input", error && "ld-input--error", className)}
        aria-invalid={error ? true : undefined}
        {...rest}
      />
      {error ? <div className="ld-field-error">{error}</div> : null}
      {!error && hint ? <div className="ld-field__hint">{hint}</div> : null}
    </label>
  );
}
