import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
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
  /** Drops toasts raised before a page change; one an action raised just now stays. */
  dismissStale: () => void;
};

/** A toast younger than this belongs to the action that changed the page. */
const PAGE_CHANGE_GRACE_MS = 500;

const ToastContext = createContext<ToastApi | null>(null);

let toastSeq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<(ToastItem & { at: number })[]>([]);

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (message: string, tone: ToastTone = "info") => {
      const id = `t-${Date.now()}-${(toastSeq += 1)}`;
      setItems((prev) => [...prev, { id, message, tone, at: Date.now() }]);
      // Errors carry what staff must do next; give them time to be read.
      setTimeout(() => dismiss(id), tone === "error" ? 6000 : 4000);
    },
    [dismiss],
  );

  const dismissStale = useCallback(() => {
    const cutoff = Date.now() - PAGE_CHANGE_GRACE_MS;
    setItems((prev) =>
      prev.some((t) => t.at < cutoff) ? prev.filter((t) => t.at >= cutoff) : prev,
    );
  }, []);

  const api = useMemo(() => ({ push, dismiss, dismissStale }), [push, dismiss, dismissStale]);

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

/** Clears the previous page's toasts whenever `pageKey` changes; a no-op without a provider. */
export function useToastPageScope(pageKey: string): void {
  const dismissStale = useContext(ToastContext)?.dismissStale;
  useEffect(() => {
    dismissStale?.();
  }, [pageKey, dismissStale]);
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
          className="ld-toast__dismiss"
          aria-label="关闭通知"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
