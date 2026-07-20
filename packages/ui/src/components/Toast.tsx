import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { cn } from "../lib/cn.js";

export type ToastTone = "info" | "success" | "error" | "warning";

export type ToastItem = {
  id: string;
  message: string;
  tone: ToastTone;
};

type ToastApi = {
  push: (message: string, tone?: ToastTone) => void;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

let toastSeq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (message: string, tone: ToastTone = "info") => {
      const id = `t-${Date.now()}-${(toastSeq += 1)}`;
      setItems((prev) => [...prev, { id, message, tone }]);
      window.setTimeout(() => dismiss(id), 4000);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="ld-toast-viewport" aria-live="polite">
        {items.map((t) => (
          <ToastView key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return ctx;
}

export function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss?: () => void }) {
  return (
    <div className={cn("ld-toast", item.tone !== "info" && `ld-toast--${item.tone}`)} role="status">
      <span>{item.message}</span>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          style={{
            marginLeft: 12,
            border: 0,
            background: "transparent",
            cursor: "pointer",
            color: "inherit",
            fontWeight: 700,
          }}
          aria-label="关闭通知"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
